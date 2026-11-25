import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, readJson, str, HttpError } from "@/lib/auth";
import { identifyPlaces } from "@/lib/ai";
import { resolvePlace } from "@/lib/geo";
import { aiBudget } from "@/lib/limits";

export const maxDuration = 30;

/** "หาไม่เจอ? ให้ AI ช่วยหา": turn a loose query (Thai transliteration, nickname, street-food stall) into real places. */
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/search-ai">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await requireMember(req, id);
    const b = await readJson(req);
    const q = str(b.q, 120);
    if (!q || q.length < 2) throw new HttpError(400, "พิมพ์ชื่อที่อยากหาก่อน");
    const [trip] = await sql`select destination, dest_lat::float8 as lat, dest_lng::float8 as lng from pinpai.trips where id = ${id}`;
    const cacheKey = `ai-search:${(trip.destination ?? "").toLowerCase()}:${q.toLowerCase()}`;
    const [hit] = await sql`select result from pinpai.imports where url = ${cacheKey} and status = 'done' and created_at > now() - interval '30 days' limit 1`;
    if (hit) return NextResponse.json(hit.result);
    const meter = await aiBudget(id, "search-ai", req);
    const found = await identifyPlaces(q, trip.destination, meter);
    const anchor = trip.lat != null ? { lat: trip.lat, lng: trip.lng } : null;
    const results = (await Promise.all(found.map(async (p) => {
      const expected = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : anchor;
      const loc = await resolvePlace(p.name_local ?? p.name, p.city, expected, 25, { anchor, areaKm: 100, alt: p.name_local ? p.name : null, category: p.category });
      if (!loc) return null;
      return { name: p.name_local && p.name_local !== p.name ? `${p.name_local} (${p.name})` : p.name, lat: loc.lat, lng: loc.lng,
        address: loc.address || p.city || "", category: p.category, approx: loc.approx, why: p.why };
    }))).filter(Boolean);
    const out = { results, source: "ai" };
    if (results.length) await sql`insert into pinpai.imports (trip_id, url, platform, status, result) values (${id}, ${cacheKey}, 'search-ai', 'done', ${sql.json(out as never)})`;
    return NextResponse.json(out);
  });
}

import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, readJson, str, num, HttpError } from "@/lib/auth";
import { recommendPlaces } from "@/lib/ai";
import { resolvePlace } from "@/lib/geo";
import { aiBudget } from "@/lib/limits";
import { findPhoto, mapLimit } from "@/lib/photos";

export const maxDuration = 60;
const KINDS = ["food", "attraction", "cafe", "nightlife"] as const;

export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/recommend">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await requireMember(req, id);
    const b = await readJson(req);
    const kind = (KINDS as readonly string[]).includes(b.kind as string) ? (b.kind as (typeof KINDS)[number]) : "attraction";
    const [trip] = await sql`select destination, dest_lat, dest_lng from pinpai.trips where id = ${id}`;
    if (!trip.destination) throw new HttpError(400, "ใส่จุดหมายของทริปก่อน แล้วค่อยขอคำแนะนำ");
    const existing = await sql`select name, lat::float8 as lat, lng::float8 as lng, day_index from pinpai.places where trip_id = ${id}`;
    const day = num(b.day_index);
    const dayPlaces = day != null ? existing.filter((p) => p.day_index === day && p.lat != null) : [];
    const near = dayPlaces.length ? dayPlaces.map((p) => p.name).slice(0, 5).join(", ") : str(b.near, 120);
    const note = str(b.note, 200);
    const fresh = b.fresh === true;
    const cacheKey = `rec:${kind}:${day ?? "all"}:${(note ?? "").toLowerCase()}`;
    if (!fresh) {
      const [hit] = await sql`select result from pinpai.imports where trip_id = ${id} and url = ${cacheKey} and status = 'done' and created_at > now() - interval '6 hours' order by created_at desc limit 1`;
      if (hit) return NextResponse.json(hit.result);
    }
    const meter = await aiBudget(id, "recommend", req);
    const recs = await recommendPlaces({ destination: trip.destination, kind, near, exclude: existing.map((p) => p.name as string), note }, meter);
    const anchor = dayPlaces.length
      ? { lat: dayPlaces.reduce((s, p) => s + p.lat, 0) / dayPlaces.length, lng: dayPlaces.reduce((s, p) => s + p.lng, 0) / dayPlaces.length }
      : trip.dest_lat != null ? { lat: trip.dest_lat, lng: trip.dest_lng } : null;
    const base = await Promise.all(recs.map(async (p) => {
      const expected = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : anchor;
      const loc = await resolvePlace(p.name_local ?? p.name, p.city, expected, 12, { anchor: trip.dest_lat != null ? { lat: Number(trip.dest_lat), lng: Number(trip.dest_lng) } : anchor, alt: p.name_local ? p.name : null, category: p.category });
      return { name: p.name_local && p.name_local !== p.name ? `${p.name_local} (${p.name})` : p.name, category: p.category, why: p.why,
        lat: loc?.lat ?? null, lng: loc?.lng ?? null, address: loc?.address ?? null, approx: loc?.approx ?? true };
    }));
    const places = await mapLimit(base, 4, async (p) => ({ ...p, photo: await findPhoto({ name: p.name, lat: p.lat, lng: p.lng }) }));
    await sql`insert into pinpai.imports (trip_id, url, platform, status, result) values (${id}, ${cacheKey}, 'recommend', 'done', ${sql.json({ places } as never)})`;
    return NextResponse.json({ places });
  });
}

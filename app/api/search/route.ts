import { NextResponse } from "next/server";
import { searchPlaces, suggestDestinations, hasThai, isInThailand, distKm, sameName, type GeoHit } from "@/lib/geo";
import { sql } from "@/lib/db";
import { requireMember } from "@/lib/auth";
import { translatePlaceQuery } from "@/lib/ai";
import { aiBudget } from "@/lib/limits";
import { rateLimit } from "@/lib/ratelimit";
import { HttpError } from "@/lib/auth";

export async function GET(req: Request) {
  try { rateLimit(req, "search", 60, 60_000); } catch (e) { return NextResponse.json({ results: [], error: (e as HttpError).message }, { status: 429 }); }
  const sp = new URL(req.url).searchParams;
  const q = (sp.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (q.length < 2) return NextResponse.json({ results: [] });
  if (sp.get("type") === "dest") {
    const results = await suggestDestinations(q);
    return NextResponse.json({ results, source: "photon" }, { headers: { "Cache-Control": results.length ? "public, s-maxage=604800, stale-while-revalidate=2592000" : "public, s-maxage=60" } });
  }
  // place search hits OpenStreetMap's shared Nominatim (1 req/s policy): only for members of a trip, so it can't be used as an open proxy
  const tripParam = sp.get("trip");
  try { if (!tripParam) throw new HttpError(401, "กรุณาเข้าร่วมทริปก่อน"); await requireMember(req, tripParam); }
  catch (e) { return NextResponse.json({ results: [], error: e instanceof HttpError ? e.message : "ระบบขัดข้อง" }, { status: e instanceof HttpError ? e.status : 500 }); }
  const lat = Number(sp.get("lat")), lng = Number(sp.get("lng"));
  const near = sp.get("lat") && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  const r = await searchPlaces(q, near, { limit: 7, deep: sp.get("deep") === "1" });

  // Thai words for a place abroad rarely match OSM: translate once (cached), then search the local/English names
  const trip = sp.get("trip");
  const weak = !r.results.length || (r.results[0].score ?? 0) < 35;
  if (trip && near && hasThai(q) && !isInThailand(near) && weak && q.length >= 3) {
    try {
      const key = `tr:${near.lat.toFixed(1)},${near.lng.toFixed(1)}:${q.toLowerCase()}`;
      const [hit] = await sql`select data from pinpai.route_cache where key = ${key}`;
      let names: string[] = hit?.data?.queries ?? [];
      if (!hit) {
        const [t] = await sql`select destination from pinpai.trips where id = ${trip}`;
        const meter = await aiBudget(trip, "search-translate", req);
        names = await translatePlaceQuery(q, t?.destination ?? null, meter);
        await sql`insert into pinpai.route_cache (key, data) values (${key}, ${sql.json({ queries: names } as never)}) on conflict (key) do nothing`;
      }
      const dest = (await sql`select destination from pinpai.trips where id = ${trip}`)[0]?.destination ?? "";
      // only search real place names: drop Thai echoes and the bare city name
      names = names.filter((n) => n && !hasThai(n) && !sameName(n, dest) && !sameName(n, String(dest).split(",")[0])).slice(0, 2);
      const more = (await Promise.all(names.map((n) => searchPlaces(n, near, { limit: 5 })))).flatMap((x) => x.results);
      const merged: GeoHit[] = [];
      const all = [...more, ...r.results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      for (const h of all) {
        const radius = h.category === "attraction" || h.category === "nature" ? 2 : 0.4;
        if (!merged.some((m) => sameName(m.name, h.name) && distKm(m, h) < radius)) merged.push(h);
      }
      return NextResponse.json({ results: merged.slice(0, 7), source: "translated", translated: names }, { headers: { "Cache-Control": "private, max-age=300" } });
    } catch { /* fall through to plain results */ }
  }
  // identical query+area from any user is served from Vercel's edge cache
  return NextResponse.json(r, { headers: { "Cache-Control": r.results.length ? "public, s-maxage=86400, stale-while-revalidate=604800" : "public, s-maxage=60" } });
}

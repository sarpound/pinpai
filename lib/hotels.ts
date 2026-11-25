// Hotel placement: the AI names a hotel before it knows exactly where the days will go, and often picks one
// 8 km from everything (Hangzhou: Qianjiang instead of West Lake). After the days are placed we know where the
// group actually spends its time, so the code — not the model — checks the hotel against that and, when it is
// clearly off, swaps it for a real mapped hotel near the middle of those days. Hotels people chose are never touched.
import { createHash } from "crypto";
import { sql } from "./db";
import { distKm } from "./geo";
import { nominatim } from "./eats";

type Pt = { lat: number; lng: number };
type Cand = Pt & { name: string; address: string; kind: string; stars: number | null; brand: boolean };

const LUX = /hyatt|four seasons|ritz|mandarin oriental|peninsula|shangri|intercontinental|conrad|aman|banyan tree|waldorf|st\.? regis|rosewood|capella|w hotel|park hyatt|grand hyatt|jw marriott|sofitel|fairmont|raffles|anantara|six senses|bulgari|edition|kempinski|regent|okura|imperial|oriental|langham|cordis|alila|como |the westin|sheraton grand|ritz-carlton|wanda vista|hilton|marriott/i;
const BUDGETY = /hostel|backpack|capsule|dorm|youth|青年旅舍|ゲストハウス|게스트하우스/i;

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** robust middle of a set of points: coordinate-wise median, then drop points > 3× median spread and recompute */
export function middleOf(pts: Pt[]): { c: Pt; spread: number } | null {
  if (pts.length < 2) return null;
  let c = { lat: median(pts.map((p) => p.lat)), lng: median(pts.map((p) => p.lng)) };
  const spread0 = median(pts.map((p) => distKm(p, c)));
  const core = pts.filter((p) => distKm(p, c) <= Math.max(4, spread0 * 3));
  if (core.length >= 2) c = { lat: median(core.map((p) => p.lat)), lng: median(core.map((p) => p.lng)) };
  return { c, spread: median(core.map((p) => distKm(p, c))) };
}

async function hotelsNear(p: Pt, km: number): Promise<Cand[]> {
  const d = km / 111;
  const key = createHash("sha1").update(`hotels1:${km}:${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).digest("hex");
  const [hit] = await sql`select data from pinpai.route_cache where key = ${key} and created_at > now() - interval '30 days'`.catch(() => []);
  if (hit) return hit.data as Cand[];
  const dl = d / Math.max(0.3, Math.cos((p.lat * Math.PI) / 180));
  const box = `${p.lng - dl},${p.lat + d},${p.lng + dl},${p.lat - d}`;
  const raw = await nominatim(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=hotel&viewbox=${box}&bounded=1&limit=40&extratags=1`).catch(() => []);
  const seen = new Set<string>();
  const out: Cand[] = raw.filter((x) => x.name && x.name.length > 2 && ["hotel", "guest_house", "hostel", "apartment", "motel", "resort"].includes(x.type) && !seen.has(x.name) && (seen.add(x.name), true))
    .map((x) => ({ name: x.name, lat: Number(x.lat), lng: Number(x.lon), address: x.display_name.split(",").slice(0, 3).join(",").trim(), kind: x.type,
      stars: Number.isFinite(Number(x.extratags?.stars)) ? Number(x.extratags!.stars) : null, brand: !!(x.extratags?.brand || x.extratags?.["brand:wikidata"]) }));
  await sql`insert into pinpai.route_cache (key, data) values (${key}, ${sql.json(out as never)}) on conflict (key) do update set data = excluded.data, created_at = now()`.catch(() => {});
  return out;
}

/** how well a mapped hotel fits the trip's budget (higher is better); null = don't offer it */
function fit(c: Cand, budget: string): number | null {
  const lux = LUX.test(c.name) || (c.stars ?? 0) >= 5, cheap = c.kind === "hostel" || BUDGETY.test(c.name);
  if (budget === "luxury") return lux ? 3 : (c.stars ?? 0) >= 4 ? 2 : c.kind === "hotel" && c.brand ? 0.5 : null;
  if (budget === "budget") return cheap || c.kind === "guest_house" ? 2 : (c.stars ?? 3) <= 3 && !lux ? 1.5 : null;
  // mid: proper hotels, not hostels, not palaces
  if (cheap) return null;
  return c.kind === "hotel" ? ((c.stars ?? 3.5) >= 3 && (c.stars ?? 3.5) <= 4.5 ? 2 : 1) + (c.brand ? 0.5 : 0) : 0.5;
}

export type RehomeNote = { from: string; to: string; savedKm: number };

/**
 * For each AI-chosen stay whose nights fall inside `scope` (all of them when null): compare it with the middle of
 * where the group goes on those days; if it's clearly off, move it to the best mapped hotel near that middle.
 */
export async function rehomeHotels(tripId: string, scope: [number, number] | null, deadline: number): Promise<RehomeNote[]> {
  const [trip] = await sql`select start_date::text, end_date::text, prefs from pinpai.trips where id = ${tripId}`;
  if (!trip?.start_date || !trip?.end_date) return [];
  const days = Math.round((Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 864e5) + 1;
  const budget = String(trip.prefs?.budget ?? "mid");
  const stays = await sql`select p.id, p.name, p.day_index, p.lat::float8 as lat, p.lng::float8 as lng, p.source, p.details,
      exists (select 1 from pinpai.votes v where v.place_id = p.id) as voted
    from pinpai.places p where p.trip_id = ${tripId} and p.category = 'stay' and p.day_index is not null order by p.day_index, p.sort_order`;
  const notes: RehomeNote[] = [];
  for (let i = 0; i < stays.length; i++) {
    if (Date.now() > deadline - 15_000) break;
    const s = stays[i];
    const from = s.day_index as number, to = Math.min(days - 1, (stays[i + 1]?.day_index ?? days) as number);   // the days they wake/sleep here
    if (scope && (from < scope[0] || to - 1 > scope[1])) continue;     // nights outside this block: a later block will see them
    const owned = s.source !== "ai" || s.details?.user_edited || s.details?.fixed_time || s.voted || s.details?.rehomed;
    if (owned) continue;
    const pts = (await sql`select lat::float8 as lat, lng::float8 as lng from pinpai.places where trip_id = ${tripId}
        and day_index between ${from} and ${to} and lat is not null and category not in ('stay', 'transport')
        and coalesce(details->>'kind', '') not in ('hotel_task', 'run', 'meal_fill')`) as unknown as Pt[];
    const r = await rehomeStay(tripId, s as never, pts, budget, deadline);
    if (r) notes.push(r);
  }
  return notes;
}

/** move one AI hotel next to the middle of `pts` when it is clearly off; returns what changed */
export async function rehomeStay(tripId: string, s: { id: string; name: string; lat: number | null; lng: number | null }, pts: Pt[], budget: string, deadline: number): Promise<RehomeNote | null> {
    const mid = middleOf(pts);
    if (!mid) return null;
    const cur = s.lat != null ? distKm({ lat: s.lat, lng: s.lng! }, mid.c) : Infinity;
    // clearly off: farther from the middle than most stops are, and more than 3 km
    if (cur <= Math.max(3, mid.spread * 1.2)) return null;
    let cands = (await hotelsNear(mid.c, 1.5)).filter((c) => fit(c, budget) != null);
    if (cands.length < 3 && Date.now() < deadline - 15_000) cands = [...cands, ...(await hotelsNear(mid.c, 3.5)).filter((c) => fit(c, budget) != null)];
    const best = cands.map((c) => ({ c, d: distKm(c, mid.c), f: fit(c, budget)! }))
      .filter((x) => x.d < cur - 2)                                     // must be a real improvement
      .sort((a, b) => (a.d - a.f * 0.6) - (b.d - b.f * 0.6))[0];
    if (!best) return null;
    const old = String(s.name);
    await sql`update pinpai.places set name = ${best.c.name.slice(0, 160)}, lat = ${best.c.lat}, lng = ${best.c.lng}, address = ${best.c.address.slice(0, 300)},
        details = coalesce(details, '{}'::jsonb) - 'approx' - 'wiki' - 'verified' - 'unverified' || ${sql.json({
          rehomed: { from: old, km: Number.isFinite(cur) ? Math.round(cur * 10) / 10 : null },
          why: `ใกล้จุดเที่ยวของช่วงนี้ (ห่างจุดกึ่งกลาง ~${best.d.toFixed(1)} กม.${Number.isFinite(cur) ? ` · เดิม ${old} ห่าง ~${cur.toFixed(0)} กม.` : ""})`,
        } as never)}, updated_at = now()
      where id = ${s.id} and trip_id = ${tripId}`;
    return { from: old, to: best.c.name, savedKm: Number.isFinite(cur) ? Math.round((cur - best.d) * 10) / 10 : 0 };
}

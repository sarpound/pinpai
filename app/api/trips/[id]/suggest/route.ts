import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, readJson, str, num, HttpError } from "@/lib/auth";
import { suggestNearby, isGatewayDown } from "@/lib/ai";
import { resolvePlace, sameName } from "@/lib/geo";
import { aiBudget } from "@/lib/limits";
import { findPhoto, mapLimit } from "@/lib/photos";

export const maxDuration = 60;
const KINDS = ["food", "cafe", "attraction"] as const;
const MEALS = ["breakfast", "lunch", "dinner", "snack", "late"];
type Kind = (typeof KINDS)[number];

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}
/** rough door-to-door time: walk up to ~1.2 km, otherwise a short ride */
function hop(d: number, mode: string) {
  const road = d * 1.3;
  if (d <= 1.2 || mode === "walk") return { min: Math.max(2, Math.round((road / 4.8) * 60)), walk: true };
  return { min: Math.round((road / (mode === "transit" ? 18 : 22)) * 60) + (mode === "transit" ? 10 : 5), walk: false };
}
const fits = (kind: Kind, cat: string) => kind === "food" ? cat === "food" : kind === "cafe" ? cat === "cafe" || cat === "food" : !["food", "cafe", "stay", "transport"].includes(cat);

/**
 * Up to 3 places around one point. The group's own wishlist (friends' hearts first) comes before AI ideas;
 * AI results are cached per ~100 m grid cell so the same gap costs one AI call for everyone.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/suggest">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await requireMember(req, id);
    const b = await readJson(req);
    const lat = num(b.lat), lng = num(b.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, "ไม่มีพิกัดของจุดนี้ เลยหาที่ใกล้ๆ ไม่ได้");
    const kind: Kind = (KINDS as readonly string[]).includes(b.kind as string) ? (b.kind as Kind) : "attraction";
    const meal = MEALS.includes(b.meal as string) ? (b.meal as string) : null;
    const at = typeof b.at === "string" && /^\d{2}:\d{2}$/.test(b.at) ? b.at : null;
    const here = { lat, lng };
    const maxKm = kind === "attraction" ? 4 : 2.5;
    const [trip] = await sql`select destination, prefs from pinpai.trips where id = ${id}`;
    const prefs = (trip.prefs ?? {}) as { food?: string[]; companions?: string; mode?: string };
    const mode = prefs.mode ?? "taxi";
    const all = await sql`select p.id, p.name, p.category, p.lat::float8 as lat, p.lng::float8 as lng, p.day_index, p.details, p.address,
        (select count(*)::int from pinpai.votes v where v.place_id = p.id) as votes,
        (select m.name from pinpai.members m where m.id = p.added_by) as by
      from pinpai.places p where p.trip_id = ${id}`;
    const taken = all.map((p) => p.name as string);

    // 1) what the group already wants to go to
    const ll = (p: { lat?: unknown; lng?: unknown }) => ({ lat: Number(p.lat), lng: Number(p.lng) });
    const wish = all.filter((p) => p.day_index == null && p.lat != null && fits(kind, p.category) && km(here, ll(p)) <= maxKm)
      .sort((a, z) => z.votes - a.votes || km(here, ll(a)) - km(here, ll(z))).slice(0, 3)
      .map((p) => { const d = km(here, ll(p)); return { wish_id: p.id as string, name: p.name as string, category: p.category as string,
        why: (p.details?.why as string) ?? null, lat: p.lat, lng: p.lng, address: p.address, photo: p.details?.photo ?? null,
        votes: p.votes as number, by: p.by as string | null, km: Math.round(d * 10) / 10, ...hop(d, mode) }; });
    if (wish.length >= 3 || b.wish_only === true) return NextResponse.json({ options: wish.slice(0, 3) });

    // 2) AI ideas around the point (cached)
    const foodKey = (prefs.food ?? []).filter((f) => ["halal", "veg", "mild", "seafood", "street", "famous"].includes(f)).sort().join(",");
    const key = `sug:v1:${kind}:${meal ?? ""}:${lat.toFixed(3)}:${lng.toFixed(3)}:${kind === "attraction" ? "" : foodKey}:${prefs.companions === "date" ? "d" : ""}`;
    type Opt = { name: string; category: string; why: string | null; lat: number; lng: number; address: string | null; photo: unknown };
    let pool: Opt[] | null = null;
    const [hit] = await sql`select data from pinpai.route_cache where key = ${key} and created_at > now() - interval '14 days'`;
    if (hit) pool = (hit.data as { places: Opt[] }).places;
    let aiError: string | null = null;
    if (!pool) {
      try {
        const meter = await aiBudget(id, "suggest");
        const recs = await suggestNearby({ destination: trip.destination ?? "", kind, lat, lng, label: str(b.label, 120), meal, at,
          food: prefs.food, companions: prefs.companions, exclude: taken }, meter);
        const located = await mapLimit(recs, 4, async (p) => {
          const expected = p.lat != null && p.lng != null && km(here, { lat: p.lat, lng: p.lng }) <= 6 ? { lat: p.lat, lng: p.lng } : here;
          const loc = await resolvePlace(p.name_local ?? p.name, p.city, expected, 5, { anchor: here, areaKm: maxKm, alt: p.name_local ? p.name : null, category: p.category }).catch(() => null);
          const pt = loc ?? (p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng, address: null } : null);
          if (!pt || km(here, pt) > maxKm + 0.5) return null;
          const name = p.name_local && p.name_local !== p.name && !p.name_local.includes(p.name) && !p.name.includes(p.name_local) ? `${p.name_local} (${p.name})` : p.name_local || p.name;
          const category = kind === "attraction" ? (["food", "cafe", "stay"].includes(p.category) ? "attraction" : p.category) : kind === "cafe" ? "cafe" : p.category === "cafe" ? "cafe" : "food";
          return { name: name.slice(0, 160), category, why: p.why, lat: pt.lat, lng: pt.lng, address: pt.address ?? null } as Omit<Opt, "photo">;
        });
        const ok = located.filter(Boolean) as Omit<Opt, "photo">[];
        pool = await mapLimit(ok, 4, async (p) => ({ ...p, photo: await findPhoto({ name: p.name, lat: p.lat, lng: p.lng, category: p.category }).catch(() => null) }));
        if (pool.length) await sql`insert into pinpai.route_cache (key, data) values (${key}, ${sql.json({ places: pool } as never)})
          on conflict (key) do update set data = excluded.data, created_at = now()`;
      } catch (e) {
        if ((e as { status?: number }).status) aiError = (e as Error).message;
        else aiError = isGatewayDown(e) ? "ระบบ AI ไม่ว่างชั่วคราว ลองใหม่อีกสักครู่" : "หาไอเดียไม่สำเร็จ ลองใหม่อีกครั้ง";
        pool = [];
      }
    }
    const ideas = pool
      .filter((p) => !taken.some((t) => sameName(t, p.name)) && !wish.some((w) => sameName(w.name, p.name)))
      .map((p) => { const d = km(here, p); return { ...p, km: Math.round(d * 10) / 10, ...hop(d, mode) }; })
      .sort((a, z) => a.km - z.km);
    const options = [...wish, ...ideas].slice(0, 3);
    return NextResponse.json({ options, ...(aiError && !options.length ? { error: aiError } : {}) });
  });
}

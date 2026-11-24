// Safety net for meals: when the AI (free tier, rate-limited) leaves a lunch/dinner/breakfast empty, find a real
// restaurant from OpenStreetMap (Nominatim, bounded to ~1 km around the stop) — real pin, real name, cuisine tag,
// opening hours when mapped. Results are cached; requests are spaced ≥1.1 s apart (Nominatim usage policy).
import { createHash } from "crypto";
import { sql } from "./db";

const UA = "PinPai/0.2 (trip planner; https://pinpai-sarpounds-projects.vercel.app)";
export type Eatery = { name: string; lat: number; lng: number; address: string; cuisine: string | null; hours: string | null; brand: boolean; kind: string; halal?: boolean; veg?: boolean };

let lastCall = 0;
async function nominatim(url: string) {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  return (await r.json()) as { name: string; lat: string; lon: string; display_name: string; type: string; extratags?: Record<string, string> }[];
}

/** restaurants (or cafés for breakfast) within ~1 km of a point */
export async function eateriesNear(p: { lat: number; lng: number }, kind: "restaurant" | "cafe", diet?: "veg" | "halal" | null): Promise<Eatery[]> {
  const key = createHash("sha1").update(`eat3:${kind}:${diet ?? ""}:${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).digest("hex");
  const [hit] = await sql`select data from pinpai.route_cache where key = ${key} and created_at > now() - interval '14 days'`.catch(() => []);
  if (hit) return hit.data as Eatery[];
  const box = (d: number) => { const dl = d / Math.max(0.3, Math.cos((p.lat * Math.PI) / 180)); return `${p.lng - dl},${p.lat + d},${p.lng + dl},${p.lat - d}`; };
  const q = (what: string, d: number) => nominatim(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(what)}&viewbox=${box(d)}&bounded=1&limit=25&extratags=1`).catch(() => []);
  // ~1 km first; rural stops (temples, rice terraces) get ~3 km; veg / halal groups also search for those words
  let raw = await q(kind, 0.009);
  // OSM tags few places; "vegetarian" as a search word finds almost nothing, "vegan" does — look wider (~4 km)
  if (diet === "veg") { raw = [...raw, ...(await q("vegan", 0.036))]; if (raw.filter((x) => /yes|only/.test(`${x.extratags?.["diet:vegan"] ?? ""}${x.extratags?.["diet:vegetarian"] ?? ""}`)).length < 2) raw = [...raw, ...(await q("vegetarian", 0.036))]; }
  if (diet === "halal") raw = [...raw, ...(await q("halal", 0.036))];
  if (raw.filter((x) => x.name).length < 3) raw = [...raw, ...(await q(kind, 0.027))];
  raw = raw.filter((x, i, a) => a.findIndex((y) => y.name === x.name && y.lat === x.lat) === i);
  const out: Eatery[] = raw.filter((x) => x.name && x.name.length > 1).map((x) => ({
    name: x.name, lat: Number(x.lat), lng: Number(x.lon), address: x.display_name.split(",").slice(0, 3).join(",").trim(),
    cuisine: x.extratags?.cuisine ?? null, hours: x.extratags?.opening_hours ?? null, brand: !!(x.extratags?.brand || x.extratags?.["brand:wikidata"]), kind: x.type,
    halal: /yes|only/.test(x.extratags?.["diet:halal"] ?? "") || /halal/i.test(`${x.name} ${x.extratags?.cuisine ?? ""}`),
    veg: /yes|only/.test(`${x.extratags?.["diet:vegetarian"] ?? ""}${x.extratags?.["diet:vegan"] ?? ""}`) || /vegetarian|vegan|มังสวิรัติ|เจ|indian/i.test(`${x.name} ${x.extratags?.cuisine ?? ""}`),
  }));
  if (out.length) await sql`insert into pinpai.route_cache (key, data) values (${key}, ${sql.json(out as never)}) on conflict (key) do update set data = excluded.data, created_at = now()`.catch(() => {});
  return out;
}

/** any named OSM place matching a word ("onsen", "massage", "viewpoint"…) within ~d degrees of a point, closest first; cached */
export async function placesNear(p: { lat: number; lng: number }, words: string[], d = 0.027) {
  const key = createHash("sha1").update(`near:${words.join("|")}:${d}:${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).digest("hex");
  const [hit] = await sql`select data from pinpai.route_cache where key = ${key} and created_at > now() - interval '14 days'`.catch(() => []);
  if (hit) return hit.data as Eatery[];
  const dl = d / Math.max(0.3, Math.cos((p.lat * Math.PI) / 180));
  const box = `${p.lng - dl},${p.lat + d},${p.lng + dl},${p.lat - d}`;
  let raw: Awaited<ReturnType<typeof nominatim>> = [];
  for (const w of words) {
    raw = [...raw, ...(await nominatim(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(w)}&viewbox=${box}&bounded=1&limit=15&extratags=1`).catch(() => []))];
    if (raw.filter((x) => x.name).length >= 5) break;
  }
  const seen = new Set<string>();
  const out: Eatery[] = raw.filter((x) => x.name && x.name.length > 1 && !seen.has(x.name) && (seen.add(x.name), true)).map((x) => ({
    name: x.name, lat: Number(x.lat), lng: Number(x.lon), address: x.display_name.split(",").slice(0, 3).join(",").trim(),
    cuisine: null, hours: x.extratags?.opening_hours ?? null, brand: !!(x.extratags?.brand || x.extratags?.["brand:wikidata"]), kind: x.type,
  })).sort((a, b) => dist(p, a) - dist(p, b));
  await sql`insert into pinpai.route_cache (key, data) values (${key}, ${sql.json(out as never)}) on conflict (key) do update set data = excluded.data, created_at = now()`.catch(() => {});
  return out;
}

/** does an OSM opening_hours string allow this minute of the day? unknown/complex formats → yes */
export function openAt(hours: string | null, min: number) {
  if (!hours) return true;
  if (/24\/7/.test(hours)) return true;
  const spans = [...hours.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)].map((m) => [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
  if (!spans.length) return true;
  return spans.some(([a, b]) => (b > a ? min >= a && min <= b - 45 : min >= a || min <= b - 45));
}

const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};

/** best real place for a meal: open then, matches the group's food focus, not a fast-food chain, close, not already used */
export function pickEatery(list: Eatery[], o: { near: { lat: number; lng: number }; at: number; meal: string; food: string[]; used: Set<string>; spicyOk: boolean }) {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const SPICY = /sichuan|szechuan|hunan|chongqing|hot ?pot|mala|spicy|火锅|川|湘/i;
  // halal / vegetarian groups: only places mapped as such (never a guess)
  const KONBINI = /^(convenience|supermarket|fuel|vending_machine)$|familymart|family mart|7-eleven|seven-eleven|lawson|ministop|cu\b|gs25|ファミリーマート|セブン|ローソン/i;
  const scored = list.filter((e) => !KONBINI.test(e.kind) && !KONBINI.test(e.name) && !o.used.has(norm(e.name)) && openAt(e.hours, o.at) && (o.spicyOk || !SPICY.test(`${e.name} ${e.cuisine ?? ""}`))
      && (!o.food.includes("halal") || e.halal) && (!o.food.includes("veg") || e.veg))
    .map((e) => {
      let s = -dist(o.near, e) * 2;                                   // closer is better (km)
      if (e.brand) s -= o.meal === "breakfast" ? 0.5 : 2;             // chains only if nothing else
      if (e.cuisine) s += 0.6;                                        // mapped well = usually established
      if (e.hours) s += 0.4;
      if (o.food.includes("thai") && /thai/i.test(e.cuisine ?? "")) s += 1.5;
      if (o.meal === "breakfast" && /breakfast|brunch|coffee|bakery|cafe/i.test(`${e.cuisine} ${e.kind} ${e.name}`)) s += 1;
      if (o.meal !== "breakfast" && /coffee_shop|ice_cream|bubble|donut|dessert/i.test(e.cuisine ?? "")) s -= 1.5;
      return { e, s };
    }).sort((a, b) => b.s - a.s);
  return scored[0]?.e ?? null;
}

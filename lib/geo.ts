// Place search on OpenStreetMap data: Photon (fast, typo-tolerant) → ranked, de-duplicated,
// cached; Nominatim only as a single fallback (its policy forbids autocomplete use).
export type GeoHit = { name: string; lat: number; lng: number; address: string; kind?: string; category?: string; score?: number };

const UA = "PinPai/0.2 (trip planner; https://pinpai-sarpounds-projects.vercel.app)";

// ---------- small LRU cache (per server instance) ----------
const cache = new Map<string, { at: number; v: GeoHit[] }>();
const TTL = 6 * 3600_000;
function cget(k: string) {
  const e = cache.get(k);
  if (!e || Date.now() - e.at > TTL) return null;
  cache.delete(k); cache.set(k, e); // refresh LRU order
  return e.v;
}
function cset(k: string, v: GeoHit[]) {
  cache.set(k, { at: Date.now(), v });
  if (cache.size > 800) cache.delete(cache.keys().next().value!);
}

export function distKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const inThailand = (p: { lat: number; lng: number }) => p.lat > 5.5 && p.lat < 20.6 && p.lng > 97.3 && p.lng < 105.7;

// What kind of OSM object it is → how useful it is to a traveller, and our category.
const CLASS: [RegExp, number, string][] = [
  [/^tourism:(attraction|viewpoint|museum|theme_park|zoo|aquarium|gallery)$/, 30, "attraction"],
  [/^tourism:artwork$/, 12, "attraction"], // statues/plaques often share a famous place's name
  [/^(natural:(water|lake|wood|valley|glacier|ridge|hill|dune|geyser|hot_spring)|water:(lake|reservoir|lagoon|river|pond)|waterway:(river|waterfall|canal)|place:(islet|archipelago))$/, 28, "nature"],
  [/^historic:/, 26, "attraction"],
  [/^amenity:place_of_worship$/, 26, "attraction"],
  [/^natural:(beach|peak|waterfall|volcano|bay|cave_entrance|cape|spring)$/, 26, "nature"],
  [/^(leisure:(park|nature_reserve|garden|beach_resort|water_park)|boundary:(national_park|protected_area))$/, 22, "nature"],
  [/^amenity:(restaurant|fast_food|food_court|street_food)$/, 24, "food"],
  [/^amenity:(cafe|ice_cream)$|^shop:(coffee|bakery|pastry)$/, 24, "cafe"],
  [/^amenity:(bar|pub|nightclub)$/, 20, "nightlife"],
  [/^amenity:marketplace$|^shop:(mall|department_store|market)$/, 24, "shopping"],
  [/^shop:/, 8, "shopping"],
  [/^tourism:(hotel|hostel|guest_house|resort|motel|apartment)$/, 20, "stay"],
  [/^(aeroway:aerodrome|railway:station|public_transport:station|amenity:(bus_station|ferry_terminal))$/, 14, "transport"],
  [/^place:(city|town|village|island|suburb)$/, 12, "other"],
  [/^tourism:/, 16, "attraction"],
  [/^amenity:/, 2, "other"],
  [/^(landuse|building|highway|man_made|military|office|power|barrier|construction|amenity:parking)/, -25, "other"],
  [/^place:(quarter|neighbourhood|locality|house)$/, -10, "other"],
];
function classify(kind: string) {
  for (const [re, w, cat] of CLASS) if (re.test(kind)) return { w, cat };
  return { w: 0, cat: "other" };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[\s\-_.,'’()]+/g, "");

function textScore(q: string, name: string) {
  const a = norm(q), b = norm(name);
  if (!a || !b) return 0;
  if (a === b) return 40;
  if (b.startsWith(a)) return 30;
  if (b.includes(a)) return 22;
  if (a.includes(b)) return 15;
  // token overlap
  const qt = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = qt.filter((t) => b.includes(norm(t))).length;
  return qt.length ? Math.round((hit / qt.length) * 18) : 0;
}

function fmtAddress(p: Record<string, string | undefined>) {
  return [p.street, p.district, p.city ?? p.county, p.state, p.country].filter(Boolean).join(", ");
}

type PhotonFeature = { geometry: { coordinates: [number, number] }; properties: Record<string, string> };

async function photon(q: string, near: { lat: number; lng: number } | null, limit: number, lang: string | null) {
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", q);
  u.searchParams.set("limit", String(limit));
  if (lang) u.searchParams.set("lang", lang);
  if (near) {
    u.searchParams.set("lat", near.lat.toFixed(3));
    u.searchParams.set("lon", near.lng.toFixed(3));
    u.searchParams.set("zoom", "11");
    u.searchParams.set("location_bias_scale", "0.3");
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
      if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) return ((await r.json()) as { features: PhotonFeature[] }).features;
      if (r.status !== 429 && r.status < 500) return [];
    } catch {}
    await new Promise((res) => setTimeout(res, 350)); // public instance throttles bursts
  }
  return null; // unavailable
}

async function nominatim(q: string, near: { lat: number; lng: number } | null, limit: number): Promise<GeoHit[]> {
  try {
    const n = new URL("https://nominatim.openstreetmap.org/search");
    n.searchParams.set("q", q);
    n.searchParams.set("format", "jsonv2");
    n.searchParams.set("limit", String(limit));
    n.searchParams.set("accept-language", "th,en");
    if (near) n.searchParams.set("viewbox", `${near.lng - 0.6},${near.lat + 0.6},${near.lng + 0.6},${near.lat - 0.6}`);
    const r = await fetch(n, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { name: string; display_name: string; lat: string; lon: string; category: string; type: string }[];
    return j.map((x) => ({ name: x.name || q, lat: Number(x.lat), lng: Number(x.lon), address: x.display_name, kind: `${x.category}:${x.type}` }));
  } catch {
    return [];
  }
}

/** Rank by name match + traveller usefulness + closeness to the trip; drop duplicates. */
function rank(q: string, hits: GeoHit[], near: { lat: number; lng: number } | null, limit: number) {
  const scored = hits.map((h) => {
    const { w, cat } = classify(h.kind ?? "");
    const d = near ? distKm(near, h) : 0;
    const distPenalty = near ? Math.min(40, d < 3 ? 0 : Math.log2(d / 3) * 6) : 0;
    return { ...h, category: cat, score: Math.round(textScore(q, h.name) + w - distPenalty) };
  });
  scored.sort((a, b) => b.score! - a.score!);
  const out: GeoHit[] = [];
  for (const h of scored) {
    // same name within 400 m = same place (OSM often has node + building + area)
    // landmarks/nature are big areas (lake, temple complex) → merge same name within 2 km; shops stay at 400 m (chains)
    const radius = h.category === "attraction" || h.category === "nature" ? 2 : 0.4;
    if (out.some((o) => norm(o.name) === norm(h.name) && distKm(o, h) < radius)) continue;
    out.push(h);
    if (out.length >= limit) break;
  }
  // if we have good POIs, drop junk (parking lots, buildings, construction…)
  const good = out.filter((h) => (h.score ?? 0) > 0);
  return good.length >= 2 ? good : out;
}

export const sameName = (a: string, b: string) => norm(a) === norm(b);
export const hasThai = (s: string) => /[\u0E00-\u0E7F]/.test(s);
export const isInThailand = (p: { lat: number; lng: number }) => inThailand(p);

export type SearchResult = { results: GeoHit[]; source: "photon" | "nominatim" | "none"; degraded?: boolean };

/**
 * Search places for the add-place box and for resolving AI-extracted names.
 * deep=true also asks Nominatim when Photon finds nothing (explicit user search only).
 */
export async function searchPlaces(q: string, near: { lat: number; lng: number } | null, opts: { limit?: number; deep?: boolean } = {}): Promise<SearchResult> {
  const limit = opts.limit ?? 6;
  const key = `${norm(q)}|${near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : "-"}|${limit}|${opts.deep ? 1 : 0}`;
  const hit = cget(key);
  if (hit) return { results: hit, source: "photon" };
  // Thai names inside Thailand; English labels abroad (otherwise Japan shows only kanji, etc.)
  const lang = near && !inThailand(near) ? "en" : null;
  const feats = await photon(q, near, 15, lang);
  let hits: GeoHit[] = (feats ?? []).map((f) => ({
    name: f.properties.name ?? f.properties.street ?? q,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    address: fmtAddress(f.properties),
    kind: `${f.properties.osm_key}:${f.properties.osm_value}`,
  }));
  let source: SearchResult["source"] = "photon";
  if (!hits.length && (opts.deep || feats === null)) {
    hits = await nominatim(q, near, 8);
    source = hits.length ? "nominatim" : "none";
  }
  let results = rank(q, hits, near, limit);
  // stay in the trip's region: drop far-away namesakes when there are nearby matches
  if (near) {
    const close = results.filter((h) => distKm(near, h) <= 300);
    if (close.length) results = close;
  }
  if (results.length) cset(key, results);
  return { results, source, degraded: feats === null };
}

/** Geocode a trip destination (city / province / country), not a shop that happens to share the name. */
export async function geocodeDestination(q: string): Promise<GeoHit | null> {
  const key = `dest|${norm(q)}`;
  const c = cget(key);
  if (c) return c[0] ?? null;
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "3");
  for (const l of ["city", "county", "state", "country", "district", "locality"]) u.searchParams.append("layer", l);
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
      const f = ((await r.json()) as { features: PhotonFeature[] }).features[0];
      if (f) {
        const h = { name: f.properties.name ?? q, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], address: fmtAddress(f.properties), kind: `${f.properties.osm_key}:${f.properties.osm_value}` };
        cset(key, [h]);
        return h;
      }
    }
  } catch {}
  return (await nominatim(q, null, 1))[0] ?? null;
}

/** A city / island / province on a long trip's route ("Koh Lanta, Thailand"): only an area counts, never a shop or a hotel sharing the name. */
export async function geocodeArea(q: string): Promise<GeoHit | null> {
  const h = await geocodeDestination(q).catch(() => null);
  if (h && /^(place|boundary):/.test(h.kind ?? "")) return h;
  // islands and some towns are not in the city layers: ask Nominatim, which ranks areas first
  const n = (await nominatim(q, null, 3).catch(() => [] as GeoHit[]))[0];
  return n ?? null;
}

/** Autocomplete for trip destinations: cities, provinces, islands, countries. */
export async function suggestDestinations(q: string): Promise<GeoHit[]> {
  const key = `destsug|${norm(q)}`;
  const c = cget(key);
  if (c) return c;
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "10");
  for (const l of ["city", "county", "state", "country", "district", "locality"]) u.searchParams.append("layer", l);
  let feats: PhotonFeature[] = [];
  for (let attempt = 0; attempt < 2 && !feats.length; attempt++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
      if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) { feats = ((await r.json()) as { features: PhotonFeature[] }).features; break; }
    } catch {}
    await new Promise((res) => setTimeout(res, 300));
  }
  const out: GeoHit[] = [];
  // Photon has no Thai names for most foreign cities ("หางโจว"); Nominatim does — one fallback call, results cached
  if (!feats.length && q.length >= 4) {
    try {
      const n = new URL("https://nominatim.openstreetmap.org/search");
      n.searchParams.set("q", q); n.searchParams.set("format", "jsonv2"); n.searchParams.set("limit", "5");
      n.searchParams.set("accept-language", "th,en"); n.searchParams.set("featureType", "settlement");
      const r = await fetch(n, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = (await r.json()) as { name: string; display_name: string; lat: string; lon: string; category: string; type: string }[];
        for (const x of j) {
          const parts = x.display_name.split(",").map((s) => s.trim());
          const h: GeoHit = { name: x.name || parts[0], lat: Number(x.lat), lng: Number(x.lon), address: [parts.length > 2 ? parts[parts.length - 2] : null, parts[parts.length - 1]].filter(Boolean).join(", "), kind: `${x.category}:${x.type}` };
          if (!out.some((o) => norm(o.name) === norm(h.name) && distKm(o, h) < 30)) out.push(h);
        }
      }
    } catch {}
  }
  for (const f of feats) {
    const p = f.properties;
    const name = p.name ?? q;
    const h: GeoHit = {
      name, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      address: [p.state && p.state !== name ? p.state : null, p.country && p.country !== name ? p.country : null].filter(Boolean).join(", "),
      kind: `${p.osm_key}:${p.osm_value}`,
    };
    // the same place often comes back as city + province + boundary; keep one
    if (out.some((o) => norm(o.name) === norm(h.name) && distKm(o, h) < 30)) continue;
    out.push(h);
    if (out.length >= 6) break;
  }
  if (out.length) cset(key, out);
  return out;
}

/** Back-compat helper: plain list of hits. */
export async function geocode(q: string, near?: { lat: number; lng: number } | null, limit = 5): Promise<GeoHit[]> {
  return (await searchPlaces(q, near ?? null, { limit, deep: true })).results;
}

/**
 * Find coordinates for a place name.
 * `expected` is the AI's guess (often 10-30 km off abroad), `anchor` the trip's destination.
 * Order of trust: a map hit close to the guess → a map hit anywhere in the destination area → the guess itself (approx).
 */
export async function resolvePlace(
  name: string,
  city: string | null,
  expected: { lat: number; lng: number } | null,
  maxKm = 60,
  opts: { anchor?: { lat: number; lng: number } | null; areaKm?: number; alt?: string | null; category?: string | null; nearest?: boolean; strict?: boolean } = {},
): Promise<{ lat: number; lng: number; address: string; approx: boolean } | null> {
  const anchor = opts.anchor ?? null, areaKm = opts.areaKm ?? 45;
  // a guess far outside the destination area is not worth biasing the search with
  const bias = expected && anchor && distKm(expected, anchor) > areaKm * 1.5 ? anchor : expected ?? anchor;
  let hits = await geocode(name, bias, 5);
  const alt = opts.alt && norm(opts.alt) !== norm(name) ? opts.alt : null;
  const inArea = (h: GeoHit) => (expected && distKm(h, expected) <= maxKm) || (anchor ? distKm(h, anchor) <= areaKm : false);
  if (alt && !hits.some(inArea)) hits = [...hits, ...(await geocode(alt, bias, 5))];
  if (!hits.some(inArea) && city) hits = [...hits, ...(await geocode(`${name} ${city}`, bias, 5))];
  const want = opts.category ?? null;
  const fit = (h: GeoHit) => (h.score ?? 0) + (want && h.category === want ? 10 : 0);
  const close = expected ? hits.filter((h) => distKm(h, expected) <= maxKm).sort((a, b) => fit(b) - fit(a)) : anchor ? [] : hits;
  if (close[0]) return { lat: close[0].lat, lng: close[0].lng, address: close[0].address, approx: false };
  // strict: only a hit near `expected` counts (used to re-check a pin that looks out of place)
  if (opts.strict) return null;
  // nearest: a chain restaurant → the branch closest to where we are, not the best-known one across town
  const area = anchor ? hits.filter((h) => distKm(h, anchor) <= areaKm).sort((a, b) => (opts.nearest && expected ? distKm(a, expected) - distKm(b, expected) : fit(b) - fit(a))) : [];
  if (area[0]) return { lat: area[0].lat, lng: area[0].lng, address: area[0].address, approx: false };
  if (expected) return { ...expected, address: city ?? "", approx: true };
  return null;
}

/** AI coordinates abroad are often shifted the same way for a whole plan: the median (guess → map hit) offset, when it is consistent. */
export function medianOffset(pairs: { guess: { lat: number; lng: number }; real: { lat: number; lng: number } }[]) {
  if (pairs.length < 4) return null;
  const med = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
  const dLat = med(pairs.map((p) => p.real.lat - p.guess.lat)), dLng = med(pairs.map((p) => p.real.lng - p.guess.lng));
  const shift = distKm({ lat: 0, lng: 0 }, { lat: dLat, lng: dLng });
  if (shift < 2) return null;
  // consistent = most pairs land within 5 km once shifted
  const okN = pairs.filter((p) => distKm({ lat: p.guess.lat + dLat, lng: p.guess.lng + dLng }, p.real) < 5).length;
  return okN >= pairs.length * 0.6 ? { dLat, dLng } : null;
}

/** Local sunrise / sunset as "HH:MM" (NOAA approximation, good to a few minutes). tzOffsetMin = minutes east of UTC. */
export function sunTimes(lat: number, lng: number, date: string, tzOffsetMin: number) {
  const d = new Date(`${date}T12:00:00Z`);
  const n = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const rad = Math.PI / 180;
  const g = (2 * Math.PI / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return null;
  const H = Math.acos(cosH) / rad;
  const noon = 720 - 4 * lng - eq + tzOffsetMin;
  const f = (m: number) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
  return { rise: f(noon - 4 * H), set: f(noon + 4 * H) };
}
/** Civil time zone offset (minutes east of UTC) from longitude, with the big single-zone countries pinned. */
export function tzOffsetMin(lat: number, lng: number, date?: string | null) {
  if (lat > 18 && lat < 54 && lng > 73 && lng < 135 && !(lng > 124 && lat < 43)) return 480; // China (one zone)
  if (lat > 5 && lat < 21 && lng > 97 && lng < 106) return 420; // Thailand
  if (lat > 24 && lat < 46 && lng > 123 && lng < 146) return 540; // Japan / Korea
  if (lat > 6 && lat < 36 && lng > 68 && lng < 90) return 330; // India
  if (lat > -45 && lat < -10 && lng > 129 && lng < 141) return 570 + dst(lat, lng, date); // Central Australia (+9:30)
  if (lat > -45 && lat < -10 && lng > 112 && lng < 129) return 480; // Western Australia
  if (lat > -48 && lat < -33 && lng > 165) return 720 + dst(lat, lng, date); // New Zealand
  if (lat > 35 && lat < 71 && lng > -10 && lng < 3 && !(lng < -5 && lat > 42 && lat < 44)) return (lng < -0.5 && lat > 49 ? 0 : lat > 49 || lng < -6 ? 0 : 60) + dst(lat, lng, date); // UK/IE/PT vs Spain/France
  if (lat > 35 && lat < 71 && lng >= 3 && lng < 22) return 60 + dst(lat, lng, date); // Central Europe
  if (lat > 34 && lat < 71 && lng >= 22 && lng < 32) return 120 + dst(lat, lng, date); // Eastern Europe / Greece
  return Math.round(lng / 15) * 60 + dst(lat, lng, date);
}

/** daylight saving (+60) for the regions that use it, by date: Europe, North America, SE Australia, New Zealand */
function dst(lat: number, lng: number, date?: string | null) {
  if (!date) return 0;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 0;
  const y = d.getUTCFullYear();
  const nth = (month: number, weekday: number, n: number) => { // n-th weekday of a month (n = -1 → last)
    if (n > 0) { const f = new Date(Date.UTC(y, month, 1)); return new Date(Date.UTC(y, month, 1 + ((weekday - f.getUTCDay() + 7) % 7) + (n - 1) * 7)); }
    const l = new Date(Date.UTC(y, month + 1, 0)); return new Date(Date.UTC(y, month, l.getUTCDate() - ((l.getUTCDay() - weekday + 7) % 7)));
  };
  const between = (a: Date, b: Date) => d >= a && d < b;
  if (lat > 34 && lat < 71 && lng > -25 && lng < 45) return between(nth(2, 0, -1), nth(9, 0, -1)) ? 60 : 0;            // Europe
  if (lat > 24 && lat < 70 && lng > -170 && lng < -52 && !(lng > -115 && lng < -108 && lat > 31 && lat < 37)) // US/Canada (not Arizona)
    return between(nth(2, 0, 2), nth(10, 0, 1)) ? 60 : 0;
  if (lat > -45 && lat < -28.2 && lng > 129 && lng < 155) return !between(nth(3, 0, 1), nth(9, 0, 1)) ? 60 : 0;          // NSW/VIC/TAS/SA/ACT
  if (lat > -48 && lat < -33 && lng > 165) return !between(nth(3, 0, 1), nth(8, 0, -1)) ? 60 : 0;                           // New Zealand
  return 0;
}

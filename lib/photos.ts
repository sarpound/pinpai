// Free, attributable place photos from Wikipedia (lead image of the matching article).
// Strategy: articles geotagged near the place whose title matches its name; else a title search
// whose coordinates are close. Restaurants/cafés rarely have one — the UI shows a styled placeholder.
import { distKm } from "./geo";

export type Photo = { url: string; page: string; title: string; source: "wikipedia" };
const UA = "PinPai/0.2 (trip planner; https://pinpai-sarpounds-projects.vercel.app)";

const mem = new Map<string, Photo | null>();

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[\s\-_.,'’()"]+/g, "");
function names(name: string) {
  // "灵隐寺 (Lingyin Temple)" → ["灵隐寺", "Lingyin Temple"]
  const m = name.match(/^(.*?)\s*\((.*)\)\s*$/);
  return (m ? [m[1], m[2]] : [name]).map((x) => x.trim()).filter(Boolean);
}
function similar(a: string, b: string) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) { const r = Math.min(x.length, y.length) / Math.max(x.length, y.length); return r > 0.7 ? 0.9 : r > 0.45 ? 0.75 : 0.5; }
  const ta = a.toLowerCase().split(/\s+/), tb = new Set(b.toLowerCase().split(/\s+/));
  const hit = ta.filter((t) => t.length > 2 && tb.has(t)).length;
  return ta.length ? hit / Math.max(ta.length, tb.size) : 0;
}

type Page = { title: string; thumbnail?: { source: string }; coordinates?: { lat: number; lon: number }[]; fullurl?: string };

async function wiki(lang: string, params: Record<string, string>): Promise<Page[]> {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({ action: "query", format: "json", formatversion: "2", prop: "pageimages|coordinates|info", inprop: "url", piprop: "thumbnail", pithumbsize: "800", ...params }))
    u.searchParams.set(k, v);
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const j = (await r.json()) as { query?: { pages?: Page[] } };
    return j.query?.pages ?? [];
  } catch {
    return [];
  }
}

function langsFor(lat: number | null, lng: number | null, name: string) {
  const ls = ["en"];
  if (/[฀-๿]/.test(name) || (lat != null && lat > 5.5 && lat < 20.6 && lng! > 97.3 && lng! < 105.7)) ls.unshift("th");
  if (/[぀-ヿ]/.test(name)) ls.push("ja");
  else if (/[一-鿿]/.test(name)) ls.push("zh");
  if (/[가-힯]/.test(name)) ls.push("ko");
  return ls;
}

export async function findPhoto(p: { name: string; lat: number | null; lng: number | null; category?: string }): Promise<Photo | null> {
  const key = `${norm(p.name)}|${p.lat?.toFixed(3)}|${p.lng?.toFixed(3)}`;
  if (mem.has(key)) return mem.get(key)!;
  const ns = names(p.name);
  const here = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null;
  const langs = langsFor(p.lat, p.lng, p.name);
  let best: { page: Page; score: number; lang: string } | null = null;

  const consider = (pages: Page[], lang: string, nearOnly: boolean) => {
    for (const pg of pages) {
      if (!pg.thumbnail?.source || /\.svg/i.test(pg.thumbnail.source)) continue; // skip maps/logos
      const sim = Math.max(...ns.map((n) => similar(n, pg.title)));
      const c = pg.coordinates?.[0];
      const d = here && c ? distKm(here, { lat: c.lat, lng: c.lon }) : null;
      if (nearOnly && (d == null || d > 2)) continue;
      if (!nearOnly && here && d != null && d > 8) continue;
      // an article we can't place on the map must match the name almost exactly ("People's Square (Dalian)" is not ours)
      if (!nearOnly && here && d == null && sim < 0.95) continue;
      if (/\(.+\)\s*$/.test(pg.title) && !ns.some((n) => norm(n) === norm(pg.title)) && d == null) continue;
      let score = sim;
      if (d != null) score += d < 0.3 ? 0.25 : d < 1 ? 0.12 : 0;
      if (score > (best?.score ?? 0)) best = { page: pg, score, lang };
    }
  };

  // 1) geotagged articles around the place
  if (here) {
    const geo = await Promise.all(langs.slice(0, 2).map((l) =>
      wiki(l, { generator: "geosearch", ggscoord: `${here.lat}|${here.lng}`, ggsradius: "1500", ggslimit: "15" }).then((r) => [l, r] as const)));
    for (const [l, pages] of geo) consider(pages, l, true);
  }
  // 2) title search
  if (!best || (best as { score: number }).score < 0.7) {
    const searches = await Promise.all(langs.slice(0, 3).flatMap((l) => ns.slice(0, 2).map((n) =>
      wiki(l, { generator: "search", gsrsearch: n, gsrlimit: "4" }).then((r) => [l, r] as const))));
    for (const [l, pages] of searches) consider(pages, l, false);
  }

  const b = best as { page: Page; score: number; lang: string } | null;
  const out: Photo | null = b && b.score >= 0.6 && b.page.thumbnail
    ? { url: b.page.thumbnail.source, page: b.page.fullurl ?? `https://${b.lang}.wikipedia.org/wiki/${encodeURIComponent(b.page.title)}`, title: b.page.title, source: "wikipedia" }
    : null;
  mem.set(key, out);
  if (mem.size > 2000) mem.delete(mem.keys().next().value!);
  return out;
}

/** Run with limited concurrency (be polite to Wikipedia). */
export async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Fill photos for unchecked places of a trip (used by the API and in the background after planning). */
export async function fillTripPhotos(tripId: string, limit = 12) {
  const { sql, bumpVersion } = await import("./db");
  const rows = await sql`select id, name, category, lat::float8 as lat, lng::float8 as lng from pinpai.places
    where trip_id = ${tripId} and not (details ? 'photo_checked') order by day_index nulls last, sort_order limit ${limit}`;
  let updated = 0;
  await mapLimit(rows, 4, async (r) => {
    const photo = await findPhoto({ name: r.name, lat: r.lat, lng: r.lng, category: r.category });
    const patch = photo ? { photo, photo_checked: true } : { photo_checked: true };
    await sql`update pinpai.places set details = details || ${sql.json(patch as never)} where id = ${r.id}`;
    if (photo) updated++;
  });
  if (updated) await bumpVersion(tripId);
  const [{ n }] = await sql`select count(*)::int as n from pinpai.places where trip_id = ${tripId} and not (details ? 'photo_checked')`;
  return { updated, remaining: n as number };
}

/**
 * Self-heal pins that were saved from an AI guess (details.approx): look the place up on the map again,
 * searching the whole destination area. Moves the pin only when a real match is found. Free — no AI.
 */
export async function fixTripPins(tripId: string, limit = 10) {
  const { sql, bumpVersion } = await import("./db");
  const { resolvePlace, medianOffset } = await import("./geo");
  const [trip] = await sql`select dest_lat::float8 as lat, dest_lng::float8 as lng from pinpai.trips where id = ${tripId}`;
  if (trip?.lat == null) return { moved: 0, remaining: 0 };
  const anchor = { lat: trip.lat as number, lng: trip.lng as number };
  const rows = await sql`select id, name, category, lat::float8 as lat, lng::float8 as lng from pinpai.places
    where trip_id = ${tripId} and details->>'approx' = 'true' and not (details ? 'geo_checked') and lat is not null
    order by day_index nulls last, sort_order limit ${limit}`;
  let moved = 0;
  const pairs: { guess: { lat: number; lng: number }; real: { lat: number; lng: number } }[] = [];
  const missed: typeof rows = [] as never;
  await mapLimit(rows, 4, async (r) => {
    const m = String(r.name).match(/^(.*?)\s*\((.*)\)\s*$/);
    const guess = { lat: r.lat as number, lng: r.lng as number };
    const loc = await resolvePlace(m ? m[1] : r.name, null, guess, 3, { anchor, alt: m ? m[2] : null, category: r.category }).catch(() => null);
    if (loc && !loc.approx) {
      pairs.push({ guess, real: loc });
      const far = distKm(guess, loc) > 0.3;
      await sql`update pinpai.places set lat = ${loc.lat}, lng = ${loc.lng}, address = coalesce(nullif(${loc.address}, ''), address),
        details = ((details - 'approx') ${far ? sql`- 'photo' - 'photo_checked'` : sql``}) || '{"geo_checked":true}'::jsonb where id = ${r.id}`;
      if (far) moved++;
    } else missed.push(r);
  });
  // places the map doesn't know: shift them the same way the others moved (the AI is usually off by one constant offset)
  const off = medianOffset(pairs);
  for (const r of missed) {
    if (off) await sql`update pinpai.places set lat = ${(r.lat as number) + off.dLat}, lng = ${(r.lng as number) + off.dLng},
      details = (details - 'photo' - 'photo_checked') || '{"geo_checked":true}'::jsonb where id = ${r.id}`;
    else await sql`update pinpai.places set details = details || '{"geo_checked":true}'::jsonb where id = ${r.id}`;
    if (off) moved++;
  }
  if (moved) await bumpVersion(tripId);
  const [{ n }] = await sql`select count(*)::int as n from pinpai.places where trip_id = ${tripId} and details->>'approx' = 'true' and not (details ? 'geo_checked') and lat is not null`;
  return { moved, remaining: n as number };
}

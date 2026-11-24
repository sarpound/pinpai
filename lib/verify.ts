// Is this sight real, known and still open? Free check against Wikipedia + Wikidata, after the AI has planned.
// - matched article near the pin → verified; its number of language editions is a rough "how famous" signal
// - Wikidata says it closed for good (dissolved / official closing date, not reopened since) → taken out of the plan
// - no article AND the map couldn't find it either (approx pin) → flagged "unverified" so the UI can say so
// Restaurants / cafés / transport / hotel tasks are skipped (rarely on Wikipedia; meals have their own checks).
import { sql, bumpVersion } from "./db";
import { distKm } from "./geo";
import { mapLimit } from "./photos";

const UA = "PinPai/0.2 (trip planner; https://pinpai-sarpounds-projects.vercel.app)";
const SIGHT = ["attraction", "nature", "shopping", "nightlife", "other"];

// "Sensō-ji" = "Senso-ji": drop accents / macrons on both sides
const fold = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f\u3099\u309a]/g, "").toLowerCase();
const norm = (s: string) => fold(s).replace(/[\s\-_.,'’()"「」・]+/g, "");
const namesOf = (name: string) => {
  const m = name.match(/^(.*?)\s*\((.*)\)\s*$/);
  return (m ? [m[1], m[2]] : [name]).map((x) => x.trim()).filter(Boolean);
};
function similar(a: string, b: string) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) { const r = Math.min(x.length, y.length) / Math.max(x.length, y.length); return r > 0.7 ? 0.9 : r > 0.45 ? 0.75 : 0.5; }
  const ta = fold(a).split(/[\s-]+/), tb = new Set(fold(b).split(/[\s-]+/));
  return ta.length ? ta.filter((t) => t.length > 2 && tb.has(t)).length / Math.max(ta.length, tb.size) : 0;
}

type Page = { title: string; fullurl?: string; coordinates?: { lat: number; lon: number }[]; pageprops?: { wikibase_item?: string } };
async function wiki(lang: string, params: Record<string, string>): Promise<Page[]> {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({ action: "query", format: "json", formatversion: "2", prop: "coordinates|pageprops|info", inprop: "url", ppprop: "wikibase_item", ...params }))
    u.searchParams.set(k, v);
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    return ((await r.json()) as { query?: { pages?: Page[] } }).query?.pages ?? [];
  } catch { return []; }
}
function langsFor(name: string, lat: number, lng: number) {
  const ls = ["en"];
  if (/[฀-๿]/.test(name) || (lat > 5.5 && lat < 20.6 && lng > 97.3 && lng < 105.7)) ls.unshift("th");
  if (/[぀-ヿ]/.test(name) || (lat > 24 && lat < 46 && lng > 123 && lng < 146 && !/[가-힯]/.test(name))) ls.push("ja");
  else if (/[一-鿿]/.test(name)) ls.push("zh");
  if (/[가-힯]/.test(name)) ls.push("ko");
  if (/[àâçéèêëîïôûùüÿœ]/i.test(name) || (lat > 42 && lat < 51.5 && lng > -5 && lng < 8.5)) ls.push("fr");
  return ls.slice(0, 3);
}

/** best Wikipedia article for a place: same name, near the pin (strict) */
async function match(p: { name: string; lat: number; lng: number; approx: boolean }) {
  const ns = namesOf(p.name), langs = langsFor(p.name, p.lat, p.lng);
  let best: { page: Page; score: number; d: number | null } | null = null;
  const consider = (pages: Page[], nearOnly: boolean) => {
    for (const pg of pages) {
      if (!pg.pageprops?.wikibase_item) continue;
      const sim = Math.max(...ns.map((n) => similar(n, pg.title.replace(/\s*\(.*\)\s*$/, ""))));
      const c = pg.coordinates?.[0];
      const d = c ? distKm({ lat: p.lat, lng: p.lng }, { lat: c.lat, lng: c.lon }) : null;
      if (nearOnly && (d == null || d > 2)) continue;
      if (!nearOnly && d != null && d > (p.approx ? 10 : 4)) continue;
      if (!nearOnly && d == null && sim < 0.95) continue;
      const score = sim + (d != null ? (d < 0.3 ? 0.25 : d < 1 ? 0.12 : 0) : 0);
      if (sim >= 0.6 && score > (best?.score ?? 0)) best = { page: pg, score, d };
    }
  };
  const geo = await Promise.all(langs.slice(0, 2).map((l) => wiki(l, { generator: "geosearch", ggscoord: `${p.lat}|${p.lng}`, ggsradius: "2000", ggslimit: "20" })));
  geo.forEach((pages) => consider(pages, true));
  if (!best || (best as { score: number }).score < 0.85) {
    const s = await Promise.all(langs.flatMap((l) => ns.slice(0, 2).map((n) => wiki(l, { generator: "search", gsrsearch: n, gsrlimit: "4" }))));
    s.forEach((pages) => consider(pages, false));
  }
  return best as { page: Page; score: number; d: number | null } | null;
}

/** sitelink counts + "closed for good" for a batch of Wikidata items (one SPARQL call) */
async function facts(ids: string[]) {
  const out = new Map<string, { n: number; closed: string | null }>();
  if (!ids.length) return out;
  const q = `SELECT ?item ?n ?closed ?opened WHERE { VALUES ?item { ${ids.map((i) => `wd:${i}`).join(" ")} }
    ?item wikibase:sitelinks ?n . OPTIONAL { ?item wdt:P576|wdt:P3999 ?closed } OPTIONAL { ?item wdt:P1619 ?opened } }`;
  try {
    const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": UA, Accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return out;
    const j = (await r.json()) as { results: { bindings: Record<string, { value: string }>[] } };
    for (const b of j.results.bindings) {
      const id = b.item.value.split("/").pop()!;
      const prev = out.get(id) ?? { n: Number(b.n?.value ?? 0), closed: null };
      const closed = b.closed?.value ?? null, opened = b.opened?.value ?? null;
      // closed, in the past, and not (re)opened after that
      if (closed && Date.parse(closed) < Date.now() && !(opened && Date.parse(opened) > Date.parse(closed))) prev.closed = closed.slice(0, 4);
      if (closed && opened && Date.parse(opened) > Date.parse(closed)) prev.closed = null;
      out.set(id, prev);
    }
  } catch { /* leave unknown */ }
  return out;
}

export async function verifyTripPlaces(tripId: string, deadline = Date.now() + 60_000, limit = 30) {
  const rows = await sql`select id, name, category, lat::float8 as lat, lng::float8 as lng, day_index, source, visited, details from pinpai.places
    where trip_id = ${tripId} and category = any(${SIGHT}) and lat is not null and not (details ? 'verified')
      and coalesce(details->>'kind', '') not in ('hotel_task', 'run', 'meal_fill')
    order by day_index nulls last, sort_order limit ${limit}`;
  if (!rows.length) return { checked: 0, closed: [] as string[] };
  const found = await mapLimit(rows, 3, async (r) => (Date.now() > deadline ? null
    : await match({ name: r.name, lat: r.lat, lng: r.lng, approx: r.details?.approx === true }).catch(() => null)));
  const ids = [...new Set(found.map((m) => m?.page.pageprops?.wikibase_item).filter((x): x is string => !!x))];
  const f = await facts(ids.slice(0, 50));
  const closed: string[] = [];
  const touchedDays = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], m = found[i];
    if (m === null && Date.now() > deadline) continue;                  // not checked this time
    const id = m?.page.pageprops?.wikibase_item;
    const info = id ? f.get(id) : undefined;
    const strict = m && m.score >= 0.85 && (m.d == null || m.d <= 2);
    if (info?.closed && strict) {
      const userOwned = r.source !== "ai" || r.details?.user_edited || r.details?.fixed_time || r.visited;
      if (!userOwned) {
        await sql`delete from pinpai.places where id = ${r.id} and trip_id = ${tripId}`;
        if (r.day_index != null) touchedDays.add(Number(r.day_index));
      } else {
        await sql`update pinpai.places set details = details || ${sql.json({ verified: true, closed: info.closed } as never)} where id = ${r.id}`;
      }
      closed.push(`${r.name} (ปิดปี ${info.closed})`);
      continue;
    }
    const patch = m && id
      ? { verified: true, wiki: { title: m.page.title, url: m.page.fullurl ?? null, langs: info?.n ?? null } }
      : { verified: true, unverified: r.details?.approx === true };
    await sql`update pinpai.places set details = details || ${sql.json(patch as never)} where id = ${r.id}`;
  }
  if (touchedDays.size) {
    const { retimeStored } = await import("./dayplan");
    for (const d of touchedDays) await retimeStored(sql, tripId, d, { keepGaps: false }).catch(() => {});
  }
  if (rows.length) await bumpVersion(tripId).catch(() => {});
  return { checked: rows.length, closed };
}

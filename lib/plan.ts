import { distKm } from "./geo";

type P = { id: string; lat: number | null; lng: number | null; day_index: number | null; category: string; duration_min: number | null };

/**
 * Spread unscheduled places across days by geography (k-means on lat/lng),
 * then order each day with a nearest-neighbour walk. Deterministic, no AI cost.
 * Existing scheduled places stay where they are; their days' centroids seed clusters.
 */
export function autoPlan(places: P[], dayCount: number): { id: string; day_index: number; sort_order: number }[] {
  if (dayCount < 1) return [];
  const located = places.filter((p) => p.lat != null && p.lng != null) as (P & { lat: number; lng: number })[];
  const free = located.filter((p) => p.day_index == null && p.category !== "stay");
  if (!free.length) return [];

  // seed centroids: existing day centroids, else spread picks
  const cents: { lat: number; lng: number }[] = [];
  for (let d = 0; d < dayCount; d++) {
    const ds = located.filter((p) => p.day_index === d);
    if (ds.length) cents[d] = { lat: avg(ds.map((p) => p.lat)), lng: avg(ds.map((p) => p.lng)) };
  }
  const pool = [...free];
  for (let d = 0; d < dayCount; d++) {
    if (cents[d]) continue;
    // farthest-point seeding
    let best = pool[0], bestD = -1;
    for (const p of pool) {
      const md = Math.min(...cents.filter(Boolean).map((c) => distKm(c, p)), Infinity);
      const score = md === Infinity ? 0 : md;
      if (score > bestD) { bestD = score; best = p; }
    }
    cents[d] = { lat: best.lat, lng: best.lng };
  }

  const cap = Math.ceil(free.length / dayCount) + 1;
  let assign = new Map<string, number>();
  for (let iter = 0; iter < 8; iter++) {
    const counts = new Array(dayCount).fill(0);
    const next = new Map<string, number>();
    // assign closest-first so balance cap doesn't push near points away
    const order = free
      .map((p) => ({ p, d: Math.min(...cents.map((c) => distKm(c, p))) }))
      .sort((a, b) => a.d - b.d);
    for (const { p } of order) {
      const ranked = cents.map((c, i) => ({ i, d: distKm(c, p) })).sort((a, b) => a.d - b.d);
      const pick = ranked.find((r) => counts[r.i] < cap) ?? ranked[0];
      counts[pick.i]++;
      next.set(p.id, pick.i);
    }
    assign = next;
    for (let d = 0; d < dayCount; d++) {
      const members = free.filter((p) => assign.get(p.id) === d);
      if (members.length) cents[d] = { lat: avg(members.map((p) => p.lat)), lng: avg(members.map((p) => p.lng)) };
    }
  }

  const out: { id: string; day_index: number; sort_order: number }[] = [];
  for (let d = 0; d < dayCount; d++) {
    const day = [...located.filter((p) => p.day_index === d), ...free.filter((p) => assign.get(p.id) === d)];
    if (!day.length) continue;
    // nearest-neighbour route; start at the westmost-northmost-ish point for stability
    const rest = [...day];
    rest.sort((a, b) => a.lng - b.lng);
    const route = [rest.shift()!];
    while (rest.length) {
      const last = route[route.length - 1];
      let bi = 0;
      for (let i = 1; i < rest.length; i++) if (distKm(last, rest[i]) < distKm(last, rest[bi])) bi = i;
      route.push(rest.splice(bi, 1)[0]);
    }
    // food goes near midday / evening naturally by keeping the geographic order; just number them
    route.forEach((p, i) => out.push({ id: p.id, day_index: d, sort_order: (i + 1) * 10 }));
  }
  return out;
}

function avg(a: number[]) {
  return a.reduce((s, x) => s + x, 0) / a.length;
}

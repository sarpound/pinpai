// Day timetable engine shared by the browser (instant preview) and the server (what gets saved).
// Pure functions only — no imports from server code, so it is safe to bundle on the client.

export type RStop = {
  id: string; name: string; category: string;
  lat: number | null; lng: number | null;
  start_time: string | null; duration_min: number | null;
  fixed?: boolean;      // user locked the start time (details.fixed_time)
  userDur?: boolean;    // user chose the duration (details.user_dur) → never squeezed
  visited?: boolean;    // already done today → stays where it is
};
export type Warning = { id: string; kind: "late" | "leave" | "overnight" | "meal" | "closed"; mins?: number; msg: string };
export type RetimeCtx = {
  mode?: string | null;       // trip prefs.mode: transit | taxi | drive | walk
  dayStart?: number | null;   // minutes; default = earliest current time of the day, else 09:00
  endBy?: number | null;      // departure day: time to leave for the airport (minutes)
  keepGaps?: boolean;         // a stop never moves earlier than its current time (used after AI planning)
  squeeze?: boolean;          // shorten flexible stops so a locked time can still be made (default true)
  notBefore?: number | null;  // "start from now": nothing that isn't done/locked starts before this (minutes)
  calib?: Calib | null;       // this trip's real road detour + driving speed, learned from routed days
};
/** learned from real road routes of this trip: road km per straight-line km, and average driving speed */
export type Calib = { detour?: number; kmh?: number; n?: number };
export type Retimed = { id: string; start_time: string | null; duration_min: number | null; next_day?: boolean };
export type RetimeResult = { stops: Retimed[]; warnings: Warning[]; travel_min: number; end_min: number | null };

export const toMin = (t: string | null | undefined) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  return m ? +m[1] * 60 + +m[2] : null;
};
export const toHHMM = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(((n % 60) + 60) % 60).padStart(2, "0")}`;
const ceil5 = (n: number) => Math.ceil(n / 5) * 5;

// typical visit length when nobody set one
const DEF_DUR: Record<string, number> = { food: 60, cafe: 45, attraction: 90, nature: 90, shopping: 75, nightlife: 90, transport: 30, other: 60 };
const MIN_DUR: Record<string, number> = { food: 35, cafe: 25, attraction: 40, nature: 40, shopping: 30, nightlife: 45, transport: 20, other: 25 };
const BIG = /disney|universal|theme ?park|amusement|legoland|safari world|chimelong|lotte world|everland|aquarium|zoo|สวนสนุก|ดรีมเวิลด์|ซาฟารี|สวนสัตว์|ธีมพาร์ค|อควาเรียม/i;
// meal windows: [earliest sensible start, latest sensible start]
// temples, museums, palaces, galleries usually close ~16:30–17:00
const DAYTIME = /temple|\bwat\b|寺|庙|วัด(?!ถุ)|museum|博物馆|美术馆|พิพิธภัณฑ์|gallery|palace|故居|memorial|纪念馆|พระราชวัง/i;
// things that only make sense in the evening: never pulled earlier than 17:00
const EVENING = /night ?market|walking street|ถนนคนเดิน|ตลาดกลางคืน|ตลาดนัดกลางคืน|ไนท์|夜市|夜景|night view|rooftop|\bbar\b|บาร์|light show|灯光|cruise|ล่องเรือ.*(ค่ำ|กลางคืน)|sunset/i;
const BAR = /\bbar\b|\bpub\b|บาร์|ผับ|club|speakeasy|rooftop|cocktail|brewery|wine bar|酒吧/i;
const DAY_MARKET = /market|ตลาด|市场|市集|mercado|bazaar|marché/i;
const NIGHT_WORD = /night|夜|กลางคืน|ไนท์|evening|ค่ำ/i;
const CAFE_WORD = /caf[eé]|coffee|espresso|bakery|brunch|คาเฟ่|กาแฟ|咖啡/i;
/** places where cafés shut mid-afternoon (Australia/NZ, Europe, North America) */
const earlyCafes = (lat: number | null, lng: number | null) => lat != null && lng != null &&
  ((lat < -10 && lng > 110) || (lat > 35 && lng > -25 && lng < 45) || (lat > 24 && lng > -170 && lng < -52));
/**
 * Is this stop likely closed at this time? Same rules for the AI planner (drops it) and the editor (warns).
 */
export function hourRule(s: Pick<RStop, "name" | "category" | "lat" | "lng">, start: number): string | null {
  const t = start % (24 * 60);
  if ((s.category === "attraction" || s.category === "other") && DAYTIME.test(s.name) && t >= 16 * 60 + 30) return "อาจปิดแล้วตอนนั้น (ปกติปิด ~17:00)";
  if ((s.category === "nightlife" || BAR.test(s.name)) && t >= 5 * 60 && t < 16 * 60) return "บาร์ส่วนใหญ่ยังไม่เปิดตอนนั้น";
  if (/music fountain|fountain show|音乐喷泉|噴水ショー|분수쇼/i.test(s.name) && t >= 5 * 60 && t < 18 * 60) return "โชว์น้ำพุมีเฉพาะช่วงค่ำ";
  if ((s.category === "shopping" || s.category === "food") && DAY_MARKET.test(s.name) && !NIGHT_WORD.test(s.name) && t >= 15 * 60 + 30) return "ตลาดกลางวันมักปิดราว 15:00";
  if ((s.category === "cafe" || CAFE_WORD.test(s.name)) && s.category !== "nightlife" && earlyCafes(s.lat, s.lng) && t >= 17 * 60 + 30) return "คาเฟ่แถวนี้มักปิดราว 16:00–17:00";
  return null;
}
const MEALS: [string, number, number][] = [["breakfast", 390, 600], ["lunch", 660, 870], ["dinner", 1050, 1260]];

export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One travel-time model for the whole app (planner, edit preview, route legs), so the numbers always agree.
 * roadKm: real road distance (or straight-line × detour); carMin: driving time from the router when known.
 * - short hops are walked by everyone (≤1 km), walkers walk up to 2.5 km
 * - transit = walk to station + wait + ride + walk out (+ a transfer on long rides), never slower than walking short hops
 * - taxi = waiting for the car + driving with a little traffic; drive = same + parking
 */
export type LegKind = "walk" | "transit" | "car";
export function legMinutes(roadKm: number, carMin: number | null, mode?: string | null, calib?: Calib | null): { min: number; kind: LegKind } {
  if (roadKm < 0.05) return { min: 0, kind: "walk" };
  const walk = Math.max(2, Math.round((roadKm / 4.5) * 60));
  if (roadKm <= 1.0 || (mode === "walk" && roadKm <= 2.5)) return { min: walk, kind: "walk" };
  // free routers know no traffic: real city driving is never faster than these speeds (learned speed can only slow it)
  const cityKmh = roadKm <= 5 ? 18 : roadKm <= 20 ? 26 : 45;
  const kmh = calib?.kmh && calib.kmh > 8 ? Math.min(calib.kmh, cityKmh) : cityKmh;
  const drive = Math.max(carMin ?? 0, (roadKm / kmh) * 60);
  if (mode === "transit" || mode === "walk") {
    const ride = (roadKm / (roadKm > 15 ? 40 : 28)) * 60;
    const min = Math.round(7 + 4 + ride + 5 + (roadKm > 10 ? 5 : 0));
    return roadKm <= 2.5 && walk <= min ? { min: walk, kind: "walk" } : { min: Math.min(min, 180), kind: "transit" };
  }
  const car = Math.round(4 + drive * 1.15 + (mode === "drive" ? 6 : 0));
  return { min: Math.min(Math.max(car, 6), 180), kind: "car" };
}

/** door-to-door minutes between two stops (straight line × this trip's road detour) */
export function travelMin(a: Pick<RStop, "lat" | "lng"> | null, b: Pick<RStop, "lat" | "lng">, mode?: string | null, calib?: Calib | null) {
  if (!a || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 15;
  const detour = calib?.detour ? Math.min(1.6, Math.max(1.15, calib.detour)) : 1.3;
  const road = km({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) * detour;
  return legMinutes(road, null, mode, calib).min;
}

/** fold one routed day into a trip's calibration (running average, capped so it keeps adapting) */
export function updateCalib(prev: Calib | null | undefined, legs: { straight: number; road: number; carMin: number }[]): Calib | null {
  const use = legs.filter((l) => l.straight >= 0.3 && l.road >= l.straight * 0.9 && l.road <= l.straight * 4);
  const drive = legs.filter((l) => l.road >= 1 && l.carMin > 0);
  if (use.length < 2 && drive.length < 2) return prev ?? null;
  const detour = use.length >= 2 ? use.reduce((a, l) => a + l.road, 0) / use.reduce((a, l) => a + l.straight, 0) : null;
  const kmh = drive.length >= 2 ? drive.reduce((a, l) => a + l.road, 0) / (drive.reduce((a, l) => a + l.carMin, 0) / 60) : null;
  const n0 = Math.min(prev?.n ?? 0, 20), n1 = use.length + drive.length;
  const mix = (o: number | undefined, x: number | null) => (x == null ? o : o == null ? x : (o * n0 + x * n1) / (n0 + n1));
  const r = (x: number | undefined, d: number) => (x == null ? undefined : Math.round(x * 10 ** d) / 10 ** d);
  return { detour: r(mix(prev?.detour, detour), 2), kmh: r(mix(prev?.kmh, kmh), 1), n: Math.min(n0 + n1, 200) };
}

const isBig = (s: RStop) => BIG.test(s.name) && (s.category === "attraction" || s.category === "nature");
const eats = (s: RStop) => s.category === "food" || s.category === "cafe";

/**
 * Recompute start times for one day in the given order.
 * Locked / visited stops (and timed transport) are anchors that never move; everything else flows:
 * start = end of previous stop + travel, rounded up to 5 min, never before its meal window.
 * When a locked time can't be made, flexible stops before it are shortened (to ≥60% / sensible minimum);
 * if that is still not enough the anchor gets a "late" warning — nothing is ever deleted here.
 */
export function retimeDay(stops: RStop[], ctx: RetimeCtx = {}): RetimeResult {
  const list = stops.filter((s) => s.category !== "stay");
  const n = list.length;
  if (!n) return { stops: [], warnings: [], travel_min: 0, end_min: null };
  const t0 = list.map((s) => toMin(s.start_time));
  const anchor = list.map((s, i) => t0[i] != null && (!!s.fixed || !!s.visited || (s.category === "transport" && (i === 0 || i === n - 1))));
  const base = list.map((s) => Math.max(5, Math.round(Number(s.duration_min) || (isBig(s) ? 480 : DEF_DUR[s.category] ?? DEF_DUR.other))));
  const floor = list.map((s, i) => (s.userDur || anchor[i] ? base[i] : Math.min(base[i], Math.max(MIN_DUR[s.category] ?? 25, Math.round(base[i] * 0.6)))));
  const dur = [...base];
  const travel = list.map((s, i) => (i ? travelMin(list[i - 1], s, ctx.mode, ctx.calib) : 0));
  // meal kind from the stop's current time → its window's lower bound
  // only restaurants hold to lunch/dinner hours; a café can move to the morning freely
  const mealLo = list.map((s, i) => {
    if (s.category !== "food" || t0[i] == null) return null;
    const m = MEALS.find(([, a, b]) => t0[i]! >= a - 30 && t0[i]! <= b + 30);
    return m ? m[1] : null;
  });
  const known = t0.filter((t): t is number => t != null);
  const dayStart = ctx.dayStart ?? (known.length ? Math.min(...known) : 9 * 60);

  let start: number[] = [];
  let late: Warning[] = [];
  const pass = () => {
    start = []; late = [];
    let free: number | null = null;
    let parkIdx = -1;
    for (let i = 0; i < n; i++) {
      const s = list[i];
      // a meal right next to a theme park happens during the park day: no travel, doesn't push the park
      if (parkIdx >= 0 && eats(s) && !anchor[i] && list[parkIdx].lat != null && s.lat != null &&
        km(list[parkIdx] as { lat: number; lng: number }, s as { lat: number; lng: number }) < 3 && t0[i] != null && t0[i]! < start[parkIdx] + dur[parkIdx]) {
        start.push(Math.max(t0[i]!, start[parkIdx] + 60));
        continue;
      }
      const arrive = free == null ? dayStart : free + travel[i];
      let st: number;
      if (anchor[i]) {
        st = t0[i]!;
        if (arrive > st + 5) late.push({ id: s.id, kind: "late", mins: arrive - st, msg: `ไปไม่ทัน ช้าไป ${arrive - st} นาที` });
      } else {
        st = ceil5(arrive);
        if (ctx.notBefore != null && !s.visited) st = Math.max(st, ceil5(ctx.notBefore));
        if (mealLo[i] != null) st = Math.max(st, mealLo[i]!);
        if ((s.category === "nightlife" || EVENING.test(s.name)) && (t0[i] == null || t0[i]! >= 16 * 60)) st = Math.max(st, 17 * 60);
        if (ctx.keepGaps && t0[i] != null) st = Math.max(st, t0[i]!);
      }
      start.push(st);
      free = Math.max(free ?? 0, st + dur[i]);
      if (isBig(s)) parkIdx = i;
    }
  };
  pass();
  if (ctx.squeeze !== false && late.length) {
    const saved = [...dur], lateBefore = late.length;
    for (let round = 0; round < 6 && late.length; round++) {
      const w = late[0];
      const k = list.findIndex((s) => s.id === w.id);
      let over = w.mins ?? 0, cut = false;
      for (let j = k - 1; j >= 0 && over > 0 && !anchor[j]; j--) {
        const take = Math.min(dur[j] - floor[j], ceil5(over));
        if (take <= 0) continue;
        dur[j] -= take; over -= take; cut = true;
      }
      if (!cut) break;
      pass();
    }
    // shortening didn't make any locked time reachable → leave the visits as they were, just warn
    if (late.length >= lateBefore) { dur.splice(0, n, ...saved); pass(); }
  }

  const warnings: Warning[] = [...late];
  for (let i = 0; i < n; i++) {
    const s = list[i];
    if (start[i] >= 24 * 60) warnings.push({ id: s.id, kind: "overnight", msg: "เลยเที่ยงคืน" });
    if (ctx.endBy != null && s.category !== "transport" && start[i] + dur[i] > ctx.endBy)
      warnings.push({ id: s.id, kind: "leave", mins: start[i] + dur[i] - ctx.endBy, msg: `เลยเวลาออกไปสนามบิน ${toHHMM(ctx.endBy)}` });
    const shut = start[i] < 24 * 60 ? hourRule(s, start[i]) : null;
    if (shut) warnings.push({ id: s.id, kind: "closed", msg: shut });
    const m = mealLo[i] != null ? MEALS.find(([, a]) => a === mealLo[i]) : null;
    if (m && start[i] > m[2] + 30) warnings.push({ id: s.id, kind: "meal", msg: `มื้อนี้เลื่อนไปถึง ${toHHMM(start[i])}` });
  }
  const out: Retimed[] = list.map((s, i) => ({ id: s.id, start_time: toHHMM(start[i]), duration_min: dur[i], ...(start[i] >= 24 * 60 ? { next_day: true } : {}) }));
  const ends = start.map((st, i) => st + dur[i]);
  return { stops: out, warnings, travel_min: travel.reduce((a, b) => a + b, 0), end_min: Math.max(...ends) };
}

/**
 * Fingerprint of a day as everyone sees it (order, times, locks). The client sends the one it edited from;
 * the server refuses the save (409) if a friend changed the day in between.
 */
export function dayStamp(rows: { id: string; sort_order: number | string; start_time: string | null; duration_min: number | string | null; details?: { fixed_time?: boolean } | null }[]) {
  const key = [...rows]
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || (a.id < b.id ? -1 : 1))
    .map((r) => `${r.id}|${(r.start_time ?? "").slice(0, 5)}|${r.duration_min == null ? "" : Number(r.duration_min)}|${r.details?.fixed_time ? 1 : 0}`)
    .join(";");
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${rows.length}-${h.toString(36)}`;
}

/** ids whose position really changed (not just shifted by someone else's move): complement of the longest increasing run */
export function movedIds(before: string[], after: string[]) {
  const pos = new Map(before.map((id, i) => [id, i]));
  const seq = after.map((id) => pos.get(id) ?? -1);
  const n = seq.length, len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (seq[i] < 0) continue;
    for (let j = 0; j < i; j++) if (seq[j] >= 0 && seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const stay = new Set<string>();
  for (let i = best; i >= 0; i = prev[i]) stay.add(after[i]);
  return after.filter((id) => !stay.has(id));
}

export type Slot = {
  index: number;            // position among the day's stops (hotels excluded) where the new stop goes
  after_id: string | null;  // stop it follows (null = first of the day)
  after_name: string | null; before_name: string | null;
  start_time: string;       // when the new stop would start
  added_min: number;        // extra travel minutes for the day
  end_shift: number;        // how much later the day ends
  warnings: Warning[];      // problems this placement creates (that the day didn't have before)
};

/**
 * Where should a new stop go in a day? Try every position, re-time the day exactly the way the server will
 * (keepGaps: existing times only ever move later), and rank by extra travel, new problems, meal fit and how
 * much later the day ends. Arrival/departure transport at the ends of a day are never jumped over.
 */
export function bestSlots(day: RStop[], cand: Omit<RStop, "id" | "start_time"> & { start_time?: string | null }, ctx: RetimeCtx = {}, k = 3): Slot[] {
  const stops = day.filter((s) => s.category !== "stay");
  const c: RStop = { ...cand, id: "__new__", start_time: cand.start_time ?? null };
  const opt = { ...ctx, keepGaps: true };
  const base = retimeDay(stops, opt);
  const baseWarn = new Set(base.warnings.map((w) => `${w.id}:${w.kind}`));
  const lo = stops[0]?.category === "transport" ? 1 : 0;
  const last = stops[stops.length - 1];
  const hi = stops.length > 1 && last?.category === "transport" ? stops.length - 1 : stops.length;
  const out: (Slot & { cost: number })[] = [];
  for (let i = lo; i <= hi; i++) {
    const list = [...stops.slice(0, i), c, ...stops.slice(i)];
    const r = retimeDay(list, opt);
    const me = r.stops.find((s) => s.id === c.id)!;
    const st = toMin(me.start_time)!;
    const fresh = r.warnings.filter((w) => !baseWarn.has(`${w.id}:${w.kind}`));
    const added = r.travel_min - base.travel_min;
    const endShift = Math.max(0, (r.end_min ?? 0) - (base.end_min ?? 0));
    // disruption: how far the stops already planned get pushed, and meals pushed out of their hours
    const was = new Map(base.stops.map((x) => [x.id, toMin(x.start_time)!]));
    let shifted = 0, lateMeals = 0;
    for (const x of r.stops) {
      if (x.id === c.id) continue;
      const d = toMin(x.start_time)! - (was.get(x.id) ?? 0);
      if (d > 0) shifted += d;
      const src = stops.find((y) => y.id === x.id);
      if (d > 0 && src?.category === "food" && MEALS.some(([, a, b]) => (was.get(x.id) ?? 0) <= b && toMin(x.start_time)! > b - 60)) lateMeals++;
    }
    let cost = added + fresh.length * 60 + endShift * 0.15 + shifted * 0.12 + lateMeals * 40 + (me.next_day ? 200 : 0);
    if (cand.category === "food") {
      const inMeal = MEALS.some(([, a, b]) => st >= a && st <= b);
      if (!inMeal) cost += 45;
    }
    if (cand.category === "nightlife" && st < 18 * 60) cost += 40;
    // two meals in a row (lunch then another restaurant) is rarely what anyone wants
    if (eats(c) && ((i > 0 && eats(list[i - 1])) || (list[i + 1] && eats(list[i + 1])))) cost += 35;
    out.push({ index: i, after_id: i > 0 ? list[i - 1].id : null, after_name: i > 0 ? list[i - 1].name : null, before_name: list[i + 1]?.name ?? null,
      start_time: me.start_time!, added_min: added, end_shift: endShift, warnings: fresh, cost });
  }
  // spots that cause no problem for the new stop come first; problem spots only fill up the list
  const bad = (x: Slot) => x.warnings.some((w) => w.id === c.id);
  return out.sort((a, b) => Number(bad(a)) - Number(bad(b)) || a.cost - b.cost || a.index - b.index).slice(0, k).map(({ cost: _c, ...s }) => s);
}

/**
 * Shorter route for a day: stops that are locked, done, meals and the arrival/departure transport stay where they are;
 * the stops between them are re-ordered (exhaustive for ≤6, nearest-neighbour + 2-opt otherwise).
 * Only returned when it saves ≥5 minutes and creates no new problems.
 */
export function optimizeOrder(stops: RStop[], ctx: RetimeCtx = {}): { order: string[]; saved: number; moved: number } | null {
  const list = stops.filter((s) => s.category !== "stay");
  const n = list.length;
  if (n < 3) return null;
  const fixedAt = (i: number) => { const s = list[i]; return !!s.fixed || !!s.visited || eats(s) || s.category === "transport" || /^(🧳|🏨)/.test(s.name) || s.lat == null || s.lng == null; };
  const t = (a: RStop | null, b: RStop | null) => (a && b ? travelMin(a, b, ctx.mode, ctx.calib) : 0);
  const order = [...list];
  let i = 0;
  while (i < n) {
    if (fixedAt(i)) { i++; continue; }
    let j = i;
    while (j + 1 < n && !fixedAt(j + 1)) j++;
    const seg = order.slice(i, j + 1);
    if (seg.length >= 2) {
      const before = i > 0 ? order[i - 1] : null, after = j + 1 < n ? order[j + 1] : null;
      const cost = (arr: RStop[]) => { let c = t(before, arr[0]) + t(arr[arr.length - 1], after); for (let k = 1; k < arr.length; k++) c += t(arr[k - 1], arr[k]); return c; };
      let best = seg, bestC = cost(seg);
      if (seg.length <= 6) {
        const perm = (arr: RStop[], k = 0) => {
          if (k === arr.length) { const c = cost(arr); if (c < bestC) { bestC = c; best = [...arr]; } return; }
          for (let x = k; x < arr.length; x++) { [arr[k], arr[x]] = [arr[x], arr[k]]; perm(arr, k + 1); [arr[k], arr[x]] = [arr[x], arr[k]]; }
        };
        perm([...seg]);
      } else {
        // nearest neighbour from the stop before, then 2-opt
        const left = [...seg]; const nn: RStop[] = []; let cur = before;
        while (left.length) { left.sort((a, b) => t(cur, a) - t(cur, b)); cur = left.shift()!; nn.push(cur); }
        let arr = nn, improved = true, rounds = 0;
        while (improved && rounds++ < 50) {
          improved = false;
          for (let a = 0; a < arr.length - 1; a++) for (let b = a + 1; b < arr.length; b++) {
            const cand = [...arr.slice(0, a), ...arr.slice(a, b + 1).reverse(), ...arr.slice(b + 1)];
            if (cost(cand) < cost(arr)) { arr = cand; improved = true; }
          }
        }
        if (cost(arr) < bestC) { best = arr; bestC = cost(arr); }
      }
      order.splice(i, seg.length, ...best);
    }
    i = j + 1;
  }
  const a = retimeDay(list, ctx), b = retimeDay(order, ctx);
  const saved = a.travel_min - b.travel_min;
  if (saved < 5 || b.warnings.length > a.warnings.length) return null;
  return { order: order.map((s) => s.id), saved, moved: order.filter((s, k) => s.id !== list[k].id).length };
}

/** a better spot in the same day for one stop (e.g. a museum pushed past closing, a meal pushed out of its hours) */
export function betterSpot(stops: RStop[], id: string, ctx: RetimeCtx = {}): { order: string[]; start_time: string } | null {
  const list = stops.filter((s) => s.category !== "stay");
  const me = list.find((s) => s.id === id);
  if (!me) return null;
  const rest = list.filter((s) => s.id !== id);
  const slots = bestSlots(rest, { ...me, start_time: null, fixed: false }, { ...ctx, keepGaps: false }, 8);
  const ok = slots.find((s) => !s.warnings.some((w) => w.id === "__new__"));
  if (!ok) return null;
  const order = rest.map((s) => s.id);
  order.splice(ok.index, 0, id);
  if (order.join() === list.map((s) => s.id).join()) return null;
  return { order, start_time: ok.start_time };
}

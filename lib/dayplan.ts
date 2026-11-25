// Server side of "edit a day": load a day, recompute its timetable with lib/retime, write it back.
import type postgres from "postgres";
import { sql } from "./db";
import { retimeDay, dayStamp, type RStop, type RetimeCtx, type Warning } from "./retime";

type Tx = postgres.TransactionSql | typeof sql;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export type DayRow = { id: string; name: string; category: string; lat: number | null; lng: number | null; day_index: number | null;
  sort_order: number; start_time: string | null; duration_min: number | null; visited: boolean; details: Record<string, unknown> | null };

export async function loadDay(tx: Tx, tripId: string, day: number, lock = false) {
  const rows = lock
    ? await tx`select id, name, category, lat::float8 as lat, lng::float8 as lng, day_index, sort_order, start_time, duration_min, visited, details
        from pinpai.places where trip_id = ${tripId} and day_index = ${day} order by sort_order, created_at for update`
    : await tx`select id, name, category, lat::float8 as lat, lng::float8 as lng, day_index, sort_order, start_time, duration_min, visited, details
        from pinpai.places where trip_id = ${tripId} and day_index = ${day} order by sort_order, created_at`;
  return rows as unknown as DayRow[];
}

export const stampOf = (rows: DayRow[]) => dayStamp(rows.map((r) => ({ ...r, details: r.details as { fixed_time?: boolean } })));

export const toRStop = (r: DayRow): RStop => ({
  id: r.id, name: r.name, category: r.category, lat: r.lat, lng: r.lng, start_time: r.start_time, duration_min: r.duration_min,
  fixed: !!r.details?.fixed_time || !!r.details?.sun_time, userDur: !!r.details?.user_dur, visited: r.visited,
});

/** travel mode + "leave for the airport" time for a day, from the trip's saved prefs and members' flights */
export async function dayCtx(tx: Tx, tripId: string, day: number): Promise<RetimeCtx> {
  const [t] = await tx`select prefs, start_date, end_date from pinpai.trips where id = ${tripId}`;
  if (!t) return {};
  const days = t.start_date && t.end_date ? Math.round((Date.parse(t.end_date) - Date.parse(t.start_date)) / 864e5) + 1 : null;
  let depart: string | null = typeof t.prefs?.depart_time === "string" && HHMM.test(t.prefs.depart_time) ? t.prefs.depart_time : null;
  if (!depart && days && day === days - 1) {
    const tv = await tx`select travel->'depart'->>'time' as t from pinpai.members where trip_id = ${tripId} and travel is not null`;
    depart = tv.map((r) => r.t as string | null).filter((x): x is string => !!x && HHMM.test(x)).sort()[0] ?? null;
  }
  const last = days != null && days > 1 && day === days - 1;
  return { mode: t.prefs?.mode ?? null, endBy: last && depart ? Math.max(8 * 60, hm(depart) - 150) : null, calib: t.prefs?.calib ?? null };
}

/** recompute and store the times of one day (in its current order); returns what changed and the warnings */
export async function retimeStored(tx: Tx, tripId: string, day: number, extra: RetimeCtx = {}) {
  const rows = await loadDay(tx, tripId, day);
  const res = retimeDay(rows.map(toRStop), { ...(await dayCtx(tx, tripId, day)), ...extra });
  const byId = new Map(rows.map((r) => [r.id, r]));
  let changed = 0;
  for (const s of res.stops) {
    const r = byId.get(s.id)!;
    if ((r.start_time ?? "").slice(0, 5) === s.start_time && r.duration_min === s.duration_min) continue;
    await tx`update pinpai.places set start_time = ${s.start_time}, duration_min = ${s.duration_min}, updated_at = now() where id = ${s.id} and trip_id = ${tripId}`;
    changed++;
  }
  return { changed, warnings: res.warnings as Warning[] };
}

const HOTEL_TASK = "hotel_task";
const shortHotel = (n: string) => (/\(([^()]*[A-Za-z][^()]*)\)\s*$/.exec(n)?.[1] ?? n).slice(0, 48);
const hm2 = (t: string | null) => (t && /^\d{2}:\d{2}/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

/** which days a post-pass touches: one day, a block of days (long trips are planned a few days at a time), or all */
export type Scope = number | [number, number] | null;
/** the hotel of the night of day d (multi-city trips change hotel); the morning of day d is hotelOn(d - 1) */
async function hotels(tripId: string) {
  const rows = await sql`select lat::float8 as lat, lng::float8 as lng, day_index from pinpai.places where trip_id = ${tripId} and category = 'stay' and lat is not null order by day_index nulls first`;
  return (d: number): { lat: number; lng: number } | null => {
    const r = rows.filter((x) => (x.day_index ?? 0) <= Math.max(0, d)).pop() ?? rows[0];
    return r ? { lat: Number(r.lat), lng: Number(r.lng) } : null;
  };
}
export const inScope = (d: number, sc: Scope) => sc == null || (typeof sc === "number" ? d === sc : d >= sc[0] && d <= sc[1]);

const AIRPORT = /airport|สนามบิน|空港|공항|機場|机场|aéroport|aeropuerto|aeroporto|flughafen|luchthaven|lapangan terbang|bandara/i;
const TRANSFER = /express|arex|limousine|shuttle|airport (train|bus|link|rail)|rail ?link|skytrain to|narita express|n'ex|keisei|skyliner|heathrow express|rer b|klia ekspres|airport line|แอร์พอร์ต ?เรล|รถไฟฟ้า.*สนามบิน|공항철도|机场快线/i;
// famous places that closed for good but free models still suggest
const CLOSED = /oedo onsen monogatari|kawaii monster ?caf|robot restaurant|siam niramit|venus ?fort|palette town|toshimaen|teamlab borderless.*odaiba|odaiba.*teamlab borderless|daikanransha/i;
const VEG_BAD = /yakitori|yokocho|steak|bbq|barbecue|grill|seafood|sushi|tempura|ramen|tonkatsu|katsu|wagyu|yakiniku|burger|chicken|beef|pork|fish|crab|oyster|entrec|boucher|kebab|korean bbq|samgyeop|galbi|ซีฟู้ด|หมู|ไก่|เนื้อ|ปลา|ทะเล|焼肉|焼き鳥|寿司|烤|肉/i;
const HALAL_BAD = /pork|\bham\b|bacon|tonkatsu|izakaya|\bbar\b|\bpub\b|wine|beer|brew|yakitori|samgyeop|ramen|jamón|charcut|หมู|ร้านเหล้า|豚|猪|삼겹/i;
const DIET_OK = /vegan|vegetarian|veggie|plant|มังสวิรัติ|เจ|halal|ฮาลาล|muslim|มุสลิม/i;
const isAi = (r: DayRow) => !!r.details?.planned && !r.details?.user_edited && !r.details?.fixed_time && !r.visited && r.details?.kind !== HOTEL_TASK;
const kmBetween = (a: { lat: number | null; lng: number | null }, b: { lat: number | null; lng: number | null }) =>
  a.lat == null || b.lat == null || a.lng == null || b.lng == null ? Infinity
    : Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180));
const renumber = (tripId: string, d: number) => sql`update pinpai.places p set sort_order = r.n * 10 from (
    select id, row_number() over (order by sort_order, created_at) as n from pinpai.places where trip_id = ${tripId} and day_index = ${d}) r
  where p.id = r.id and p.trip_id = ${tripId}`;

/**
 * Deterministic clean-up of what the AI wrote, before bags / runs / meals are added:
 * - arrival day: nothing can happen before landing (the AI likes an airport café "first"); the flight is pinned to the
 *   time the group gave; separate "airport express / AREX" rows are dropped (the travel leg already covers them)
 * - departure day: nothing after the airport
 * - places that closed for good
 * - two dinners (or two lunches) in one sitting → the later one goes to the wishlist
 * - vegetarian / halal groups: an obviously meat / pork / bar place is swapped for a mapped veg / halal one nearby
 */
export async function tidyDays(tripId: string, nDays: number, onlyDay: Scope, deadline: number) {
  const [t] = await sql`select prefs, start_date::text from pinpai.trips where id = ${tripId}`;
  const startDate: string | null = t?.start_date ?? null;
  const food: string[] = t?.prefs?.food ?? [];
  const arrive: string | null = typeof t?.prefs?.arrive_time === "string" && HHMM.test(t.prefs.arrive_time) ? t.prefs.arrive_time : null;
  const diet = food.includes("halal") ? "halal" : food.includes("veg") ? "veg" : null;
  const notes: string[] = [];
  for (let d = 0; d < nDays; d++) {
    if (!inScope(d, onlyDay)) continue;
    let rows = (await loadDay(sql, tripId, d)).filter((r) => r.category !== "stay");
    const drop = async (r: DayRow, wish: boolean) => {
      if (wish) await sql`update pinpai.places set day_index = null, start_time = null where id = ${r.id} and trip_id = ${tripId}`;
      else await sql`delete from pinpai.places where id = ${r.id} and trip_id = ${tripId}`;
      rows = rows.filter((x) => x.id !== r.id);
    };
    let changed = false;
    // "ลันช์ที่ Angelina" / "เบรกฟาสต์ที่ …": the meal label belongs in the timeline, not the name; a second lunch / dinner of the day goes
    const LABEL = /^\s*(เบรกฟาสต์|อาหารเช้า|มื้อเช้า|ลันช์|อาหารกลางวัน|มื้อกลางวัน|มื้อเที่ยง|ดินเนอร์|อาหารเย็น|มื้อเย็น|มื้อค่ำ|breakfast|lunch|dinner)\s*(ที่|at|@|:)\s*/i;
    const mealOf = (s: string) => /เบรก|เช้า|breakfast/i.test(s) ? "b" : /ลันช์|กลางวัน|เที่ยง|lunch/i.test(s) ? "l" : "d";
    const WINM: Record<string, [number, number]> = { b: [360, 630], l: [660, 900], d: [1020, 1320] };
    for (const r of [...rows]) {
      const m = LABEL.exec(r.name);
      if (!m || !(r.category === "food" || r.category === "cafe")) continue;
      const meal = mealOf(m[1]), clean = r.name.slice(m[0].length).trim();
      const other = rows.find((x) => x !== r && (x.category === "food" || x.category === "cafe") && (() => {
        const lm = LABEL.exec(x.name); if (lm) return mealOf(lm[1]) === meal;
        const tt = hm2(x.start_time); return tt != null && tt >= WINM[meal][0] && tt <= WINM[meal][1];
      })());
      if (other && isAi(r) && rows.indexOf(other) < rows.indexOf(r)) { await drop(r, true); notes.push(`มื้อซ้ำ: ${r.name}`); changed = true; continue; }
      if (clean.length >= 2) { await sql`update pinpai.places set name = ${clean.slice(0, 160)} where id = ${r.id} and trip_id = ${tripId}`; r.name = clean; }
    }
    // a road is not a café ("湖滨路 (Hubin Road)" as afternoon coffee)
    for (const r of [...rows]) if ((r.category === "food" || r.category === "cafe") && isAi(r) && /^[^()（]*?(路|大道|大街)\s*(\(|$)|^[^()]*\b(Road|Street|Avenue)\)?\s*$/i.test(r.name.trim()) && !/餐|饭|馆|店|楼|坊|cafe|coffee|restaurant|kitchen/i.test(r.name)) { await drop(r, false); changed = true; }
    // "hotel" / "breakfast" as a restaurant name is a placeholder, not a place
    for (const r of [...rows]) if ((r.category === "food" || r.category === "cafe") && isAi(r) && (/^(the )?(hotel|hotel breakfast|breakfast|อาหารเช้า(ที่)?โรงแรม|โรงแรม|ที่พัก)$/i.test(r.name.trim()) || /^(a )?local (eatery|restaurant|food|diner|noodle shop|cafe)\b|\b(eatery|restaurant|food stall|cafe) (near|in|at) /i.test(r.name.replace(/^.*\(([^()]*[A-Za-z][^()]*)\)\s*$/, "$1").trim()) || /^(familymart|family mart|7-eleven|seven-eleven|lawson|ministop|gs25|cu)\b|ファミリーマート|セブン-?イレブン|ローソン/i.test(r.name.trim()))) { await drop(r, false); changed = true; }
    // breakfast at a dinner place (Peking duck at 07:55) or at a pin we could only guess: let the meal fill find a real morning café
    const DINNERY = /全聚德|quanjude|peking duck|烤鸭|hot ?pot|火锅|bbq|barbecue|烧烤|yakiniku|焼肉|steak|izakaya|居酒屋|\bpub\b|\bbar\b|buffet|ดินเนอร์|dinner/i;
    for (const r of [...rows]) {
      const t0 = hm2(r.start_time);
      if (!isAi(r) || r.category !== "food" || t0 == null || t0 >= 10 * 60 || r.details?.kind) continue;
      if (DINNERY.test(`${r.name} ${r.details?.why ?? ""}`)) { await drop(r, false); notes.push(`มื้อเช้าไม่น่าเปิด: ${r.name}`); changed = true; }
    }
    // arrival
    if (d === 0) {
      const arr = rows.find((r) => r.category === "transport" && AIRPORT.test(r.name));
      if (arr) {
        for (const r of rows.slice(0, rows.indexOf(arr))) if (isAi(r) && r.category !== "transport") { await drop(r, false); notes.push(`D0 ก่อนเครื่องลง: ${r.name}`); changed = true; }
        for (const r of rows) if (r !== arr && r.category === "transport" && isAi(r) && (TRANSFER.test(r.name) || kmBetween(r, arr) < 3)) { await drop(r, false); changed = true; }
        if (rows[0] !== arr) { await sql`update pinpai.places set sort_order = ${Number(rows[0].sort_order) - 5} where id = ${arr.id}`; changed = true; }
        if (arrive && !arr.details?.user_edited && !arr.details?.fixed_time && (arr.start_time ?? "").slice(0, 5) !== arrive) {
          await sql`update pinpai.places set start_time = ${arrive} where id = ${arr.id}`; changed = true;
        }
      }
    }
    // departure
    if (d === nDays - 1 && nDays > 1) {
      const dep = [...rows].reverse().find((r) => r.category === "transport" && AIRPORT.test(r.name))
        ?? (t?.prefs?.depart_time ? [...rows].reverse().find((r) => r.category === "transport") : undefined);
      // flew in but the AI "leaves" from a ropeway / train station / pier: leave from the airport they landed at
      if (dep && !AIRPORT.test(dep.name) && isAi(dep)) {
        const [arr] = await sql`select name, lat::float8 as lat, lng::float8 as lng from pinpai.places where trip_id = ${tripId} and day_index = 0
          and category = 'transport' order by sort_order limit 1`;
        if (arr && AIRPORT.test(String(arr.name))) {
          await sql`update pinpai.places set name = ${String(arr.name)}, lat = ${Number(arr.lat)}, lng = ${Number(arr.lng)}, address = null,
            details = details || ${sql.json({ why: "บินกลับจากสนามบินเดียวกับขาไป" } as never)} where id = ${dep.id} and trip_id = ${tripId}`;
          notes.push(`จุดออกเดินทางผิด: ${dep.name} → ${arr.name}`);
          dep.name = String(arr.name); dep.lat = Number(arr.lat); dep.lng = Number(arr.lng); changed = true;
        }
      }
      if (dep) {
        for (const r of rows.slice(rows.indexOf(dep) + 1)) if (isAi(r)) { await drop(r, false); changed = true; }
        for (const r of rows) if (r !== dep && r.category === "transport" && isAi(r) && (TRANSFER.test(r.name) || kmBetween(r, dep) < 3)) { await drop(r, false); changed = true; }
      }
    }
    // breakfast across town (the AI often picks a famous one 15-20 km away): eat near the hotel instead
    if (d > 0 && Date.now() < deadline) {
      const [hr] = await sql`select lat::float8 as lat, lng::float8 as lng from pinpai.places where trip_id = ${tripId} and category = 'stay' and lat is not null
        and day_index <= ${d - 1} order by day_index desc limit 1`;
      const h = hr ? { lat: Number(hr.lat), lng: Number(hr.lng) } : null;
      const bf = rows.find((r) => (r.category === "cafe" || r.category === "food") && (hm2(r.start_time) ?? 999) < 9 * 60 + 30);
      const firstSight = rows.find((r) => r.details?.kind !== HOTEL_TASK && r.details?.kind !== "run" && r !== bf);
      const run = rows.find((r) => r.details?.kind === "run");
      if (h && bf && isAi(bf) && kmBetween(bf, h) > 8 && !(firstSight && kmBetween(bf, firstSight) < 3) && !(run && kmBetween(bf, run) < 3)) {
        const { eateriesNear, pickEatery } = await import("./eats");
        const near = { lat: Number(h.lat), lng: Number(h.lng) };
        const e = pickEatery(await eateriesNear(near, "cafe", diet).catch(() => []), { near, at: hm2(bf.start_time) ?? 480, meal: "breakfast", food, used: new Set(), spicyOk: true });
        if (e) {
          await sql`update pinpai.places set name = ${e.name.slice(0, 160)}, lat = ${e.lat}, lng = ${e.lng}, address = ${e.address.slice(0, 300)},
            details = details || ${sql.json({ kind: "meal_fill", approx: false, why: `มื้อเช้าใกล้ที่พัก (เดิม ${bf.name.slice(0, 50)} ไกล ${Math.round(kmBetween(bf, h))} กม.)${e.cuisine ? ` · ${e.cuisine.replace(/;/g, ", ")}` : ""} (จากแผนที่ OpenStreetMap ยังไม่มีรีวิว)` } as never)}
            where id = ${bf.id} and trip_id = ${tripId}`;
          notes.push(`มื้อเช้าไกล: ${bf.name} → ${e.name}`); changed = true;
        }
      }
    }
    // a sunset stop happens at sunset (December in Hangzhou: ~17:00, not 18:30)
    if (startDate) {
      const { sunTimes, tzOffsetMin } = await import("./geo");
      for (const r of rows) {
        if (!isAi(r) || r.lat == null || r.category === "food" || r.details?.kind) continue;
        const txt = `${r.name} ${String(r.details?.why ?? "")}`;
        const date = new Date(Date.parse(startDate) + d * 864e5).toISOString().slice(0, 10);
        // sunrise: be there before first light — a summit trek (Batur, Bromo) starts ~2 h before, a viewpoint ~25 min before
        if (/พระอาทิตย์ขึ้น|sunrise|日出|日の出|해돋이|일출/i.test(txt)) {
          const sun = sunTimes(r.lat, r.lng!, date, tzOffsetMin(r.lat, r.lng!, date));
          const rise = sun ? hm2(sun.rise) : null, st = hm2(r.start_time);
          const trek = /trek|hike|climb|summit|volcano|ภูเขาไฟ|เดินป่า|ปีน|batur|bromo|ijen|fuji|登山/i.test(txt);
          const [lo, hi, want] = trek ? [150, 60, 120] : [60, 0, 25];
          if (rise == null || st == null) continue;
          if (st >= rise - lo && st <= rise - hi) { await sql`update pinpai.places set details = details || ${sql.json({ sun_time: true } as never)} where id = ${r.id} and trip_id = ${tripId}`; continue; }
          const at = Math.max(3 * 60, rise - want);
          await sql`update pinpai.places set start_time = ${`${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`},
            details = details || ${sql.json({ sun_time: true, why: `${String(r.details?.why ?? "").replace(/\s*· พระอาทิตย์ขึ้น.*$/, "").slice(0, 220)} · พระอาทิตย์ขึ้น ~${sun!.rise}${trek ? " (ออกเดินก่อนสว่าง)" : ""}` } as never)} where id = ${r.id} and trip_id = ${tripId}`;
          await sql`update pinpai.places p set sort_order = q.n * 10 from (select id, row_number() over (order by (start_time is null), start_time, sort_order) as n
            from pinpai.places where trip_id = ${tripId} and day_index = ${d} and category <> 'stay') q where p.id = q.id`;
          notes.push(`ย้ายชมพระอาทิตย์ขึ้นเป็น ${sun!.rise}: ${r.name}`); changed = true;
          continue;
        }
        if (!/พระอาทิตย์ตก|sunset|夕阳|日落|夕日/i.test(txt)) continue;
        const sun = sunTimes(r.lat, r.lng!, date, tzOffsetMin(r.lat, r.lng!, date));
        const set = sun ? hm2(sun.set) : null, st = hm2(r.start_time);
        if (set == null || st == null) continue;
        // pinned to the sun from here on: later inserts (a wanted bike ride, a meal) flow around it instead of pushing it past dark
        if (st >= set - 75 && st <= set) { await sql`update pinpai.places set details = details || ${sql.json({ sun_time: true } as never)} where id = ${r.id} and trip_id = ${tripId}`; continue; }
        const at = set - 40;
        await sql`update pinpai.places set start_time = ${`${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`},
          details = details || ${sql.json({ sun_time: true, why: `${String(r.details?.why ?? "").replace(/\s*· พระอาทิตย์ตก.*$/, "").slice(0, 220)} · พระอาทิตย์ตก ~${sun!.set}` } as never)} where id = ${r.id} and trip_id = ${tripId}`;
        // slot it by its new time
        await sql`update pinpai.places p set sort_order = q.n * 10 from (select id, row_number() over (order by (start_time is null), start_time, sort_order) as n
          from pinpai.places where trip_id = ${tripId} and day_index = ${d} and category <> 'stay') q where p.id = q.id`;
        notes.push(`ย้ายชมพระอาทิตย์ตกเป็น ${sun!.set}: ${r.name}`); changed = true;
      }
    }
    for (const r of [...rows]) if (isAi(r) && CLOSED.test(r.name)) { await drop(r, false); notes.push(`ปิดถาวร: ${r.name}`); changed = true; }
    // a sight squeezed in after 22:00 (a theatre at 22:20, a park at 23:00) — the day ran out; night markets, bars, views and shows that really run late stay
    const NIGHTOK = /night|ไนท์|ตลาดนัด|ตลาดกลางคืน|夜市|夜景|bar|pub|club|rooftop|lounge|view|observ|tower|skytree|จุดชมวิว|ถนนคนเดิน|walking street|light|cruise|ล่องเรือ|show|โชว์|cabaret|izakaya|yokocho|golden gai|karaoke|onsen|sauna|jjimjil|massage|นวด|spa|dongdaemun|street|街/i;
    for (const r of [...rows]) {
      const t0 = hm2(r.start_time);
      if (!isAi(r) || t0 == null || t0 < 22 * 60 || ["food", "cafe", "nightlife", "transport", "stay"].includes(r.category) || r.details?.kind || NIGHTOK.test(`${r.name} ${r.details?.why ?? ""}`)) continue;
      await drop(r, true); notes.push(`ดึกเกินไป ย้ายไปรอจัด: ${r.name}`); changed = true;
    }
    // moving day (Hakone → Kyoto): a stop in the new city can't come before the train that gets you there
    if (d > 0) {
      const hotelOn = await hotels(tripId);
      const origin = hotelOn(d - 1);
      const order = [...rows];
      let moved = false;
      for (let j = 0; j < order.length; j++) {
        const T = order[j];
        if (T.category !== "transport" || T.lat == null || !origin || kmBetween(T, origin) < 80) continue;
        for (let i = 0; i < j; i++) {
          const r = order[i];
          if (!isAi(r) || r.category === "transport" || r.details?.kind || r.lat == null) continue;
          if (kmBetween(r, T) < 20 && kmBetween(r, origin) > 80) {
            order.splice(i, 1); order.splice(j, 0, r); i--; j--; moved = true;
            notes.push(`ย้าย ${r.name} ไปหลังถึง ${T.name}`);
          }
        }
      }
      if (moved) {
        for (let k = 0; k < order.length; k++) {
          const r = order[k];
          const after = order.slice(0, k).some((x) => x.category === "transport" && x.lat != null && origin && kmBetween(x, origin) >= 80);
          await sql`update pinpai.places set sort_order = ${(k + 1) * 10}, start_time = ${after && r.category !== "transport" && isAi(r) ? null : r.start_time} where id = ${r.id} and trip_id = ${tripId}`;
        }
        await sql.begin((tx) => retimeStored(tx, tripId, d, { keepGaps: true }));
        rows = (await loadDay(sql, tripId, d)).filter((r) => r.category !== "stay");
        changed = true;
      }
    }
    // one dinner per evening, one lunch per midday
    const MEALY = /dinner|lunch|buffet|ดินเนอร์|บุฟเฟ่ต์|มื้อ/i;
    for (const [a, b] of [[660, 900], [1050, 1410]]) {
      const meals = rows.filter((r) => (r.category === "food" || MEALY.test(r.name)) && r.details?.kind !== "meal_fill").map((r) => ({ r, t: hm2(r.start_time) }))
        .filter((x): x is { r: DayRow; t: number } => x.t != null && x.t >= a && x.t <= b);
      const kept: typeof meals = [];
      for (const m of meals) {
        // a second sit-down restaurant late at night after dinner already happened is a second dinner too (a snack street / night market isn't)
        const lateSecond = a === 1050 && m.t >= 22 * 60 && !/street|night|market|ตลาด|夜市|屋台|yatai|snack|dessert|ของหวาน|โจ๊ก|congee|ramen/i.test(m.r.name);
        const clash = kept.filter((k) => Math.abs(m.t - k.t) < 180 || lateSecond);
        if (!clash.length) { kept.push(m); continue; }
        if (m.r.category === "food" && isAi(m.r)) { await drop(m.r, true); notes.push(`มื้อซ้ำ: ${m.r.name}`); changed = true; continue; }
        // a dinner cruise / buffet after a restaurant: the cruise is the dinner
        for (const k of clash) if (k.r.category === "food" && isAi(k.r)) { await drop(k.r, true); notes.push(`มื้อซ้ำ: ${k.r.name}`); changed = true; kept.splice(kept.indexOf(k), 1); }
        kept.push(m);
      }
    }
    // diet
    if (diet && Date.now() < deadline) {
      const BAD = diet === "halal" ? HALAL_BAD : VEG_BAD;
      const { eateriesNear, pickEatery } = await import("./eats");
      const used = new Set<string>();
      for (const r of rows) {
        if (r.category !== "food" || !isAi(r) || r.lat == null || r.lng == null || Date.now() > deadline) continue;
        const text = `${r.name} ${String(r.details?.why ?? "")}`;
        if (DIET_OK.test(text) || !BAD.test(text)) continue;
        const at = hm2(r.start_time) ?? 750;
        // search next to where the group actually is (the AI's own pin for this restaurant can be in another town)
        const i = rows.indexOf(r);
        const prev = rows.slice(0, i).reverse().find((x) => x.lat != null && x.category !== "food" && x.category !== "cafe");
        const next = rows.slice(i + 1).find((x) => x.lat != null && x.category !== "food" && x.category !== "cafe");
        const anchor = prev && next && kmBetween(r, prev) > 5 && kmBetween(r, next) > 5 ? prev : prev && kmBetween(r, prev) > 5 && !next ? prev : r;
        const here = { lat: anchor.lat!, lng: anchor.lng! };
        const list = await eateriesNear(here, "restaurant", diet).catch(() => []);
        const e = pickEatery(list, { near: here, at, meal: at < 600 ? "breakfast" : at < 960 ? "lunch" : "dinner", food, used, spicyOk: true });
        if (e) {
          used.add(e.name.toLowerCase());
          await sql`update pinpai.places set name = ${e.name.slice(0, 160)}, lat = ${e.lat}, lng = ${e.lng}, address = ${e.address.slice(0, 300)},
            details = details || ${sql.json({ kind: "meal_fill", approx: false, why: `${diet === "halal" ? "ร้านฮาลาล" : "ร้านมังสวิรัติ"}ใกล้ๆ แทน ${r.name.slice(0, 60)}${e.cuisine ? ` · ${e.cuisine.replace(/;/g, ", ")}` : ""} (จากแผนที่ OpenStreetMap ยังไม่มีรีวิว)` } as never)}
            where id = ${r.id} and trip_id = ${tripId}`;
          notes.push(`เปลี่ยนตามอาหาร: ${r.name} → ${e.name}`);
        } else {
          await sql`update pinpai.places set details = details || ${sql.json({ why: `${String(r.details?.why ?? "").slice(0, 200)} ⚠ ${diet === "halal" ? "อาจไม่ฮาลาล" : "อาจไม่มีเมนูมังสวิรัติ"} — ถามร้านก่อน` } as never)} where id = ${r.id} and trip_id = ${tripId}`;
        }
        changed = true;
      }
    }
    if (changed) { await renumber(tripId, d); await retimeStored(sql, tripId, d, { keepGaps: true }); }
  }
  return notes;
}

/**
 * What a traveller actually does with their bags, as real stops on the timeline:
 * - arrival day: airport → drop bags at the hotel (or check in if it's already afternoon) → sightseeing
 * - hotel change: check out, take the bags to the next hotel
 * - departure day: check out and leave bags at the hotel → … → back for the bags → airport
 * Re-planning removes and re-adds them (they are AI stops); a person can still drag or delete them.
 */
export async function addHotelTasks(tripId: string, nDays: number, onlyDay: Scope) {
  const stays = (await sql`select id, name, lat::float8 as lat, lng::float8 as lng, day_index from pinpai.places
    where trip_id = ${tripId} and category = 'stay' and lat is not null and day_index is not null order by day_index`) as unknown as { id: string; name: string; lat: number; lng: number; day_index: number }[];
  if (!stays.length || nDays < 2) return [] as number[];
  const stayFor = (d: number) => stays.filter((s) => s.day_index <= d).pop() ?? stays[0];
  const touched: number[] = [];
  for (let d = 0; d < nDays; d++) {
    if (!inScope(d, onlyDay)) continue;
    const rows = await loadDay(sql, tripId, d);
    if (rows.some((r) => r.details?.kind === HOTEL_TASK)) continue;
    const stops = rows.filter((r) => r.category !== "stay");
    if (!stops.length) continue;
    const add: { sort: number; name: string; dur: number; why: string; h: { lat: number; lng: number } }[] = [];
    const first = stops[0], last = stops[stops.length - 1];
    if (d === 0 && first.category === "transport") {
      const h = stayFor(0), landed = (hm2(first.start_time) ?? 600) + (first.duration_min ?? 60);
      const early = landed + 50 < 14 * 60;
      add.push({ sort: Number(first.sort_order) + 5, h, dur: early ? 20 : 30,
        name: early ? `🧳 ฝากกระเป๋าที่ ${shortHotel(h.name)}` : `🏨 เช็กอิน ${shortHotel(h.name)}`,
        why: early ? "ห้องมักพร้อมราว 14:00–15:00 ฝากกระเป๋าที่ล็อบบี้ก่อน แล้วออกเที่ยวตัวเบา" : "เช็กอิน วางกระเป๋า พักสักครู่ก่อนออกเที่ยว" });
    }
    const moveIn = d > 0 ? stays.find((s) => s.day_index === d) : null;
    if (moveIn && stays.some((s) => s.day_index < d) && !(d === nDays - 1 && last.category === "transport")) {
      const prevH = stayFor(d - 1);
      const far = prevH && prevH.lat != null && moveIn.lat != null && kmBetween(prevH, moveIn) > 30;
      // moving to another city (flight / train / boat): check out in the morning where people slept,
      // check in after the arrival — not a 07:00 "drop bags" at a hotel 700 km away
      const arrival = far ? stops.filter((r) => r.category === "transport" && r.lat != null && kmBetween(r, moveIn) < kmBetween(r, prevH)).shift() : undefined;
      if (far) {
        add.push({ sort: Number(first.sort_order) - 5, h: prevH, dur: 20, name: `🧳 เช็กเอาต์ ${shortHotel(prevH.name)}`,
          why: `เช็กเอาต์ แล้วเดินทางไป${shortHotel(moveIn.name)}` });
        const at = arrival ?? stops.find((r) => r.lat != null && kmBetween(r, moveIn) < 30);
        add.push({ sort: at ? Number(at.sort_order) + 5 : Number(last.sort_order) + 5, h: moveIn, dur: 30, name: `🏨 เช็กอิน ${shortHotel(moveIn.name)}`,
          why: "ถึงเมืองใหม่ เช็กอิน วางกระเป๋า แล้วค่อยออกเที่ยว" });
      } else add.push({ sort: Number(first.sort_order) - 5, h: moveIn, dur: 45, name: `🧳 ย้ายโรงแรม → ${shortHotel(moveIn.name)}`,
        why: "เช็กเอาต์ที่เดิม เอากระเป๋าไปฝากที่โรงแรมใหม่ก่อนออกเที่ยว (เช็กอินได้ช่วงบ่าย)" });
    }
    if (d === nDays - 1 && d > 0 && last.category === "transport" && stops.length === 1) {
      const h = stayFor(d - 1);
      add.push({ sort: Number(first.sort_order) - 5, h, dur: 20, name: `🧳 เช็กเอาต์ ${shortHotel(h.name)}`, why: "เช็กเอาต์ แล้วเดินทางไปสนามบิน" });
    }
    // departure day that leaves town (Hakone → Tokyo → Narita): check out and take the bags along — no coming back for them
    const leavesTown = d === nDays - 1 && d > 0 && last.category === "transport" && stops.length >= 2
      && (() => { const lastSeen = [...stops.slice(0, -1)].reverse().find((r) => r.lat != null && r.category !== "transport") ?? [...stops.slice(0, -1)].reverse().find((r) => r.lat != null);
        return !!lastSeen && kmBetween(lastSeen, stayFor(d - 1)) > 30; })();   // where they are before the airport is far from the hotel
    if (leavesTown) {
      const h = stayFor(d - 1);
      add.push({ sort: Number(first.sort_order) - 5, h, dur: 20, name: `🧳 เช็กเอาต์ ${shortHotel(h.name)}`, why: "เช็กเอาต์ แล้วเอากระเป๋าไปด้วย (วันนี้ไม่ได้กลับมาแถวที่พัก) · สถานีใหญ่มีล็อกเกอร์ฝากกระเป๋า" });
    }
    if (!leavesTown && d === nDays - 1 && d > 0 && last.category === "transport" && stops.length >= 2) {
      const h = stayFor(d - 1);
      add.push({ sort: Number(first.sort_order) - 5, h, dur: 15, name: `🧳 เช็กเอาต์ ฝากกระเป๋าไว้ที่ ${shortHotel(h.name)}`, why: "ส่วนใหญ่เช็กเอาต์ก่อน 11:00 ฝากกระเป๋าไว้ที่ล็อบบี้ได้ฟรี" });
      add.push({ sort: Number(last.sort_order) - 5, h, dur: 15, name: `🧳 กลับไปรับกระเป๋าที่ ${shortHotel(h.name)}`, why: "รับกระเป๋าแล้วเดินทางไปสนามบิน" });
    }
    if (!add.length) continue;
    for (const a of add)
      await sql`insert into pinpai.places (trip_id, name, category, lat, lng, day_index, sort_order, duration_min, details, source)
        values (${tripId}, ${a.name}, 'other', ${a.h.lat}, ${a.h.lng}, ${d}, ${a.sort}, ${a.dur},
          ${sql.json({ kind: HOTEL_TASK, planned: true, why: a.why } as never)}, 'ai')`;
    await sql`update pinpai.places p set sort_order = r.n * 10 from (
        select id, row_number() over (order by sort_order, created_at) as n from pinpai.places where trip_id = ${tripId} and day_index = ${d}) r
      where p.id = r.id and p.trip_id = ${tripId}`;
    // fit the extra stops in; on the departure day, if the airport can't be made any more, the last AI sight before the bag pick-up goes
    for (let round = 0; round < 3; round++) {
      let { warnings } = await retimeStored(sql, tripId, d, { keepGaps: true });
      // the AI's times often leave slack: close the gaps before dropping anything
      if (warnings.some((w) => w.kind === "late" || w.kind === "leave")) ({ warnings } = await retimeStored(sql, tripId, d, { keepGaps: false }));
      if (!warnings.some((w) => w.kind === "late" || w.kind === "leave")) break;
      const day = await loadDay(sql, tripId, d);
      const cut = day.filter((r) => r.category !== "stay" && r.category !== "transport" && r.details?.kind !== HOTEL_TASK && r.details?.planned && !r.details?.user_edited && !r.details?.fixed_time && !r.visited).pop();
      if (!cut || d !== nDays - 1) break;
      await sql`update pinpai.places set day_index = null, start_time = null where id = ${cut.id} and trip_id = ${tripId}`;
    }
    if (d === nDays - 1) {
      // bags picked up hours before anyone needs to leave: pick them up just in time instead (the free time stays free, lunch can go in it)
      const dd = await loadDay(sql, tripId, d);
      const pu = dd.find((r) => r.details?.kind === HOTEL_TASK && r.name.startsWith("🧳 กลับไปรับ"));
      const dp = [...dd].reverse().find((r) => r.category === "transport");
      const tp = hm2(pu?.start_time ?? null), td = hm2(dp?.start_time ?? null);
      if (pu && dp && tp != null && td != null) {
        const { travelMin } = await import("./retime");
        const [tt] = await sql`select prefs from pinpai.trips where id = ${tripId}`;
        const latest = td - travelMin(pu, dp, tt?.prefs?.mode ?? null, tt?.prefs?.calib ?? null) - (pu.duration_min ?? 15) - 15;
        if (latest - tp > 90) {
          await sql`update pinpai.places set start_time = ${`${String(Math.floor(latest / 60)).padStart(2, "0")}:${String(latest % 60).padStart(2, "0")}`}
            where id = ${pu.id} and trip_id = ${tripId}`;
          await retimeStored(sql, tripId, d, { keepGaps: true });
        }
      }
    }
    if (d === nDays - 1) {
      const day = await loadDay(sql, tripId, d);
      const co = day.findIndex((r) => r.details?.kind === HOTEL_TASK && r.name.startsWith("🧳 เช็กเอาต์ ฝาก"));
      const pu = day.findIndex((r) => r.details?.kind === HOTEL_TASK && r.name.startsWith("🧳 กลับไปรับ"));
      if (co >= 0 && pu > co && !day.slice(co + 1, pu).some((r) => r.category !== "stay")) {
        await sql`delete from pinpai.places where id = ${day[pu].id} and trip_id = ${tripId}`;
        await sql`update pinpai.places set name = ${`🧳 เช็กเอาต์ ${shortHotel(stayFor(d - 1).name)}`}, duration_min = 20,
          details = details || ${sql.json({ why: "เช็กเอาต์ แล้วเดินทางไปสนามบิน" } as never)} where id = ${day[co].id} and trip_id = ${tripId}`;
        await retimeStored(sql, tripId, d, { keepGaps: false });
      }
      // a plain check-out right before the airport: leave early enough to make it (not 08:30 at a hotel 30 km from an 08:30 check-in)
      const dd2 = await loadDay(sql, tripId, d);
      const ci = dd2.findIndex((r) => r.details?.kind === HOTEL_TASK && /^🧳 เช็กเอาต์ (?!ฝาก)/.test(r.name));
      const dp = [...dd2].reverse().find((r) => r.category === "transport");
      const tc = hm2(dd2[ci]?.start_time ?? null), td = hm2(dp?.start_time ?? null);
      if (ci >= 0 && dp && tc != null && td != null && dd2.indexOf(dp) > ci && !dd2.slice(ci + 1, dd2.indexOf(dp)).some((r) => r.category !== "stay")) {
        const { travelMin } = await import("./retime");
        const [tt] = await sql`select prefs from pinpai.trips where id = ${tripId}`;
        const latest = td - travelMin(dd2[ci], dp, tt?.prefs?.mode ?? null, tt?.prefs?.calib ?? null) - (dd2[ci].duration_min ?? 20) - 10;
        if (tc > latest && latest > 4 * 60) {
          await sql`update pinpai.places set start_time = ${`${String(Math.floor(latest / 60)).padStart(2, "0")}:${String(latest % 60).padStart(2, "0")}`}
            where id = ${dd2[ci].id} and trip_id = ${tripId}`;
          // a filled-in breakfast that no longer fits before leaving goes (grab something at the airport)
          for (const r of dd2.slice(0, ci)) {
            const t1 = hm2(r.start_time);
            if (r.details?.kind === "meal_fill" && t1 != null && t1 + (r.duration_min ?? 45) > latest) await sql`delete from pinpai.places where id = ${r.id} and trip_id = ${tripId}`;
          }
          await sql`update pinpai.places set details = details || ${sql.json({ fixed_time: true } as never)} where id = ${dd2[ci].id} and trip_id = ${tripId}`;
          await retimeStored(sql, tripId, d, { keepGaps: true });
        }
      }
    }
    touched.push(d);
  }
  return touched;
}

/**
 * Morning runs on real scenic routes. When the group asked for running, every full day (not arrival/departure)
 * gets a run before breakfast on a different route near the hotel; the AI's own "running spot" is replaced
 * (it is often a same-named park somewhere else). Cities without curated routes keep the AI's run only if it is
 * close to the hotel.
 */
export async function addRunRoutes(tripId: string, nDays: number, onlyDay: Scope) {
  const [t] = await sql`select prefs, start_date::text, dest_lat::float8 as lat, dest_lng::float8 as lng from pinpai.trips where id = ${tripId}`;
  if (!t || !(t.prefs?.wants ?? []).includes("run") || nDays < 3) return [] as number[];
  const hotelOn = await hotels(tripId);
  const dest = t.lat != null ? { lat: Number(t.lat), lng: Number(t.lng) } : null;
  if (!hotelOn(0) && !dest) return [];
  const { runRoutesNear, runMinutes } = await import("./activities");
  const RUNLIKE = /วิ่ง|\brun\b|jog/i;
  const touched: number[] = [];
  let k = 0;
  for (let d = 1; d < nDays - 1; d++) {
    if (!inScope(d, onlyDay)) { k++; continue; }
    // a morning run starts from where people slept (multi-city trips: that city's routes)
    const hotel = hotelOn(d - 1) ?? dest!;
    const routes = runRoutesNear(hotel);
    const rows = await loadDay(sql, tripId, d);
    const stops = rows.filter((r) => r.category !== "stay");
    if (rows.some((r) => r.details?.kind === "run" || (RUNLIKE.test(r.name) && (r.details?.user_edited || r.details?.fixed_time)))) { k++; continue; }
    const aiRuns = stops.filter((r) => r.details?.planned && !r.details?.user_edited && r.category !== "food" && r.category !== "cafe" &&
      RUNLIKE.test(`${r.name} ${String(r.details?.why ?? "")}`));
    const far = (r: DayRow) => r.lat == null || r.lng == null || Math.hypot((r.lat - hotel.lat) * 111, (r.lng - hotel.lng) * 111 * Math.cos(hotel.lat * Math.PI / 180)) > 8;
    if (!routes.length) {
      // no curated routes here: keep the AI's run only when it is actually near where people sleep
      for (const r of aiRuns.filter(far)) await sql`delete from pinpai.places where id = ${r.id} and trip_id = ${tripId}`;
      const earliest = Math.min(...stops.filter((r) => !aiRuns.includes(r)).map((r) => hm2(r.start_time) ?? 24 * 60));
      if (aiRuns.some((r) => !far(r)) || earliest < 8 * 60) continue;
      const first = stops.find((r) => !aiRuns.includes(r));
      await sql`insert into pinpai.places (trip_id, name, category, lat, lng, day_index, sort_order, start_time, duration_min, details, source)
        values (${tripId}, ${"🏃 วิ่ง 5 กม. รอบที่พัก"}, 'nature', ${hotel.lat}, ${hotel.lng}, ${d}, ${first ? Number(first.sort_order) - 5 : 5}, '06:30', ${runMinutes(5)},
          ${sql.json({ kind: "run", planned: true, why: "เมืองนี้ยังไม่มีเส้นวิ่งที่คัดไว้ — วิ่งวนรอบที่พัก/ริมหาดใกล้ๆ ถามล็อบบี้ได้ว่าเส้นไหนปลอดภัยและมีทางเท้า", route: { km: 5, start: "ที่พัก" } } as never)}, 'ai')`;
      await renumber(tripId, d);
      await retimeStored(sql, tripId, d, { keepGaps: true });
      touched.push(d);
      continue;
    }
    for (const r of aiRuns) await sql`delete from pinpai.places where id = ${r.id} and trip_id = ${tripId}`;
    // a different route each morning; a route that needs a taxi ride (> 4 km) only every other morning
    // a different route each morning: with fewer than 3 routes next door, mix in the ones a short taxi away (≤ 10 km)
    // so it isn't the same riverside 5 days running; far-only cities get a run every other morning
    const near = routes.filter((r) => r.fromHotelKm <= 4);
    const reach = routes.filter((r) => r.fromHotelKm > 4 && r.fromHotelKm <= 10);
    const pool = near.length >= 3 || !reach.length ? (near.length ? near : routes)
      : near.flatMap((r, i) => [r, ...(reach[i] ? [reach[i]] : [])]).concat(reach.slice(near.length));
    if (!near.length && !reach.length && (d % 2 === 0)) { k++; continue; }
    const route = pool[k++ % pool.length];
    const first = stops.find((r) => !aiRuns.includes(r));
    const fromHotel = route.fromHotelKm;
    // asked for sunrise too: run at first light (the run then counts as the sunrise)
    let at = 6 * 60 + 15, sunNote = "";
    if (t.start_date) {
      const { sunTimes, tzOffsetMin } = await import("./geo");
      const date = new Date(Date.parse(t.start_date) + d * 864e5).toISOString().slice(0, 10);
      const sun = sunTimes(route.lat, route.lng, date, tzOffsetMin(route.lat, route.lng, date));
      const rise = sun ? hm(sun.rise) : null;
      if (rise != null && (t.prefs?.wants ?? []).includes("sunrise")) at = Math.max(5 * 60 + 30, rise - 20);
      if (rise != null && rise >= at - 10 && rise <= at + runMinutes(route.km)) sunNote = ` · ทันพระอาทิตย์ขึ้น ~${sun!.rise}`;
    }
    const why = `${route.why} · จุดเริ่ม: ${route.start}${fromHotel <= 1.5 ? " (วิ่งจากที่พักไปได้เลย)" : ` (ห่างที่พัก ~${fromHotel} กม. นั่งแท็กซี่ ~${Math.round(8 + fromHotel * 2.2)} นาที)`}${sunNote}`;
    const hh = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
    await sql`insert into pinpai.places (trip_id, name, category, lat, lng, day_index, sort_order, start_time, duration_min, details, source)
      values (${tripId}, ${`🏃 วิ่ง ${route.km} กม. · ${route.name}`.slice(0, 160)}, 'nature', ${route.lat}, ${route.lng}, ${d},
        ${first ? Number(first.sort_order) - 5 : 5}, ${hh}, ${runMinutes(route.km)},
        ${sql.json({ kind: "run", planned: true, why: why.slice(0, 300), route: { km: route.km, start: route.start } } as never)}, 'ai')`;
    await sql`update pinpai.places p set sort_order = r.n * 10 from (
        select id, row_number() over (order by sort_order, created_at) as n from pinpai.places where trip_id = ${tripId} and day_index = ${d}) r
      where p.id = r.id and p.trip_id = ${tripId}`;
    await retimeStored(sql, tripId, d, { keepGaps: true });
    touched.push(d);
  }
  return touched;
}

/**
 * Never leave a requested meal empty. After the AI (and its repair round) is done, any lunch / dinner / breakfast
 * still missing gets a real restaurant from OpenStreetMap next to the stop before it (open at that time, matching
 * the group's food focus, not already used in the trip). Marked so the UI can say where it came from.
 */
export async function fillMissingMeals(tripId: string, nDays: number, onlyDay: Scope, deadline: number) {
  const [t] = await sql`select prefs from pinpai.trips where id = ${tripId}`;
  const meals: string[] = t?.prefs?.meals?.length ? t.prefs.meals : ["breakfast", "lunch", "dinner"];
  const food: string[] = t?.prefs?.food ?? [];
  const spicyOk = !food.includes("mild") && !/ไม่(กิน|ทาน)?เผ็ด|no spicy|not spicy/i.test(t?.prefs?.note ?? "");
  const { eateriesNear, pickEatery } = await import("./eats");
  const all = await sql`select name from pinpai.places where trip_id = ${tripId} and category in ('food','cafe')`;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const used = new Set(all.flatMap((r) => [norm(r.name), norm(r.name.split(/[(（]/)[0]), ...(/\(([^()]+)\)\s*$/.exec(r.name) ? [norm(/\(([^()]+)\)\s*$/.exec(r.name)![1])] : [])].filter((k) => k.length >= 2)));
  const WIN: Record<string, [number, number, number]> = { breakfast: [420, 600, 480], lunch: [660, 870, 750], dinner: [1050, 1260, 1140] }; // [from, to, ideal]
  const hotelOn = await hotels(tripId);
  let filled = 0;
  for (let d = 0; d < nDays && Date.now() < deadline && filled < 10; d++) {
    if (!inScope(d, onlyDay)) continue;
    const rows = (await loadDay(sql, tripId, d)).filter((r) => r.category !== "stay");
    const wrap = (t: number | null) => (t == null ? null : t < 5 * 60 ? t + 24 * 60 : t);
    const timed = rows.map((r) => ({ r, t: wrap(hm2(r.start_time)) })).filter((x): x is { r: DayRow; t: number } => x.t != null);
    if (timed.length < 2) continue;
    const first = Math.min(...timed.map((x) => x.t)), last = Math.max(...timed.map((x) => x.t + (x.r.duration_min ?? 60)));
    const arr = d === 0 ? timed.find((x) => x.r.category === "transport" && AIRPORT.test(x.r.name)) : undefined;
    const dep = d === nDays - 1 && nDays > 1 ? ([...timed].reverse().find((x) => x.r.category === "transport" && AIRPORT.test(x.r.name))
      ?? (t?.prefs?.depart_time ? [...timed].reverse().find((x) => x.r.category === "transport") : undefined)) : undefined;
    const open = arr ? arr.t + (arr.r.duration_min ?? 60) + 60 : first;      // landed + immigration/transfer
    const out = dep ? timed.find((x) => x.r.details?.kind === HOTEL_TASK && /^🧳 เช็กเอาต์ (?!ฝาก)/.test(x.r.name)) : undefined;
    const close = dep ? Math.min(dep.t - 45, out ? out.t + 15 : 26 * 60) : 26 * 60; // done before heading to the airport (or before a check-out right before it)
    let added = false;
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      if (!meals.includes(meal) || Date.now() > deadline) continue;
      const [a, b, ideal] = WIN[meal];
      if (meal === "breakfast" && (d === 0 || first > 9 * 60 + 30)) continue;
      if (Math.max(a, open) > b - 30 || Math.min(b, close) < a + 45) continue;          // not here then (landing late / flying out)
      // a late dinner (21:45 after a night market) is still dinner: don't add a second one at 19:00
      const has = timed.some((x) => (x.r.category === "food" || x.r.category === "cafe") && x.t >= a - (meal === "dinner" ? 15 : 45)
        && (x.t <= b + 30 || (meal === "dinner" && x.r.category === "food")));
      if (has) continue;
      const at = Math.min(Math.max(ideal, open), close - 60, b - 30);
      const endsEarly = !dep && last < a + 30;                                 // day over before the meal: eat near where people sleep
      const before = timed.filter((x) => x.t <= at && x.r.lat != null).pop() ?? timed.find((x) => x.r.lat != null);
      // breakfast near where people slept; an early-ending day's dinner near where they sleep tonight —
      // unless that hotel is in another town than the day (a transfer day, a wrong hotel pin): then next to the day itself
      const runAt = meal === "breakfast" ? rows.find((r) => r.details?.kind === "run" && r.lat != null) : undefined;
      const h0 = runAt ? { lat: runAt.lat!, lng: runAt.lng! } : meal === "breakfast" ? hotelOn(d - 1) : hotelOn(d);
      const pts = timed.filter((x) => x.r.lat != null && x.r.category !== "transport");
      const mid = pts.length ? { lat: [...pts].sort((p, q) => p.r.lat! - q.r.lat!)[Math.floor(pts.length / 2)].r.lat!, lng: [...pts].sort((p, q) => p.r.lng! - q.r.lng!)[Math.floor(pts.length / 2)].r.lng! } : null;
      const home = h0 && (!mid || kmBetween(h0, mid) <= 25) ? h0 : null;
      const near = (meal === "breakfast" || endsEarly) && home ? home : before ? { lat: before.r.lat!, lng: before.r.lng! } : null;
      if (!near) continue;
      const diet = food.includes("halal") ? "halal" : food.includes("veg") ? "veg" : null;
      // breakfast: cafés by the run / hotel first, then any restaurant there (lakesides and causeways have few mapped cafés)
      const tries: [{ lat: number; lng: number }, "cafe" | "restaurant"][] = meal === "breakfast"
        ? [[near, "cafe"], ...(home && home !== near ? [[home, "cafe"] as [{ lat: number; lng: number }, "cafe"]] : []), [near, "restaurant"], ...(home && home !== near ? [[home, "restaurant"] as [{ lat: number; lng: number }, "restaurant"]] : [])]
        : [[near, "restaurant"]];
      let e: ReturnType<typeof pickEatery> | null = null;
      for (const [pt, kind] of tries) {
        if (Date.now() > deadline) break;
        e = pickEatery(await eateriesNear(pt, kind, diet).catch(() => []), { near: pt, at, meal, food, used, spicyOk });
        if (e) break;
      }
      if (!e) continue;
      used.add(norm(e.name)); used.add(norm(e.name.split(/[(（]/)[0]));
      const after = timed.filter((x) => x.t <= at).pop()?.r;
      const sort = after ? Number(after.sort_order) + 5 : (Number(rows[0]?.sort_order ?? 10) - 5);
      const ideal2 = at % (24 * 60);
      const label = { breakfast: "มื้อเช้า", lunch: "มื้อกลางวัน", dinner: "มื้อเย็น" }[meal];
      await sql`insert into pinpai.places (trip_id, name, category, lat, lng, address, day_index, sort_order, start_time, duration_min, details, source)
        values (${tripId}, ${e.name.slice(0, 160)}, ${meal === "breakfast" ? "cafe" : "food"}, ${e.lat}, ${e.lng}, ${e.address.slice(0, 300)}, ${d}, ${sort},
          ${`${String(Math.floor(ideal2 / 60)).padStart(2, "0")}:${String(ideal2 % 60).padStart(2, "0")}`}, ${meal === "breakfast" ? 45 : 60},
          ${sql.json({ planned: true, kind: "meal_fill", why: `${label}ใกล้${endsEarly ? "ที่พัก" : "ๆ จุดก่อนหน้า"}${e.cuisine ? ` · ${e.cuisine.replace(/;/g, ", ")}` : ""} (จากแผนที่ OpenStreetMap ยังไม่มีรีวิว)` } as never)}, 'ai')`;
      filled++; added = true;
    }
    if (added) {
      await sql`update pinpai.places p set sort_order = r.n * 10 from (
          select id, row_number() over (order by sort_order, created_at) as n from pinpai.places where trip_id = ${tripId} and day_index = ${d}) r
        where p.id = r.id and p.trip_id = ${tripId}`;
      await retimeStored(sql, tripId, d, { keepGaps: true });
    }
  }
  return filled;
}

/**
 * Every activity the group asked for actually happens. The AI's repair round can be skipped (time) or its stop
 * dropped later (bad pin, closed, hours) — so whatever is still missing gets a real OSM venue on a full day,
 * at the natural hour (sunset at real sunset time), next to where the group is then.
 */
const WANT_RE: Record<string, RegExp> = {
  massage: /นวด|massage|\bspa\b|สปา|按摩|마사지/i, onsen: /ออนเซ็น|น้ำพุร้อน|onsen|hot spring|温泉|bathhouse|sento|銭湯|찜질방|jjimjil/i,
  beach: /ทะเล|ชายหาด|หาด|beach|ว่ายน้ำ|swim|plage|playa/i, museum: /พิพิธภัณฑ์|museum|gallery|musée|museo|美术馆|博物馆|美術館|博物館|박물관/i,
  sunset: /พระอาทิตย์ตก|sunset|ยามเย็น|夕日|夕陽/i, sunrise: /พระอาทิตย์ขึ้น|sunrise|日の出|日出/i,
  show: /โชว์|การแสดง|คอนเสิร์ต|show|concert|theat|acrobat|opera|kabuki|cabaret/i, bike: /ปั่น|จักรยาน|bike|cycl|vélo/i, hike: /เดินป่า|เดินเขา|hik|trek|trail/i,
};
const WANT_Q: Record<string, { q: string[]; at: number | "sunset" | "sunrise"; dur: number; cat: string; th: string; near: "hotel" | "before" }> = {
  massage: { q: ["massage", "spa"], at: 17 * 60, dur: 90, cat: "other", th: "นวด/สปา", near: "before" },
  onsen: { q: ["onsen", "hot spring", "sento", "jjimjilbang"], at: 19 * 60 + 30, dur: 90, cat: "other", th: "ออนเซ็น/น้ำพุร้อน", near: "before" },
  beach: { q: ["beach"], at: 15 * 60, dur: 120, cat: "nature", th: "เล่นทะเล", near: "before" },
  museum: { q: ["museum"], at: 10 * 60, dur: 120, cat: "attraction", th: "พิพิธภัณฑ์", near: "before" },
  sunset: { q: ["viewpoint", "observation deck", "rooftop bar", "beach"], at: "sunset", dur: 45, cat: "nature", th: "ดูพระอาทิตย์ตก", near: "before" },
  sunrise: { q: ["viewpoint", "beach"], at: "sunrise", dur: 45, cat: "nature", th: "ดูพระอาทิตย์ขึ้น", near: "hotel" },
  show: { q: ["theatre"], at: 19 * 60 + 30, dur: 120, cat: "attraction", th: "ดูโชว์", near: "before" },
  bike: { q: ["bicycle rental"], at: 16 * 60, dur: 90, cat: "other", th: "ปั่นจักรยาน", near: "before" },
  hike: { q: ["trailhead", "nature reserve", "viewpoint"], at: 8 * 60, dur: 150, cat: "nature", th: "เดินป่า/เดินเขา", near: "hotel" },
};

export async function ensureWants(tripId: string, nDays: number, onlyDay: Scope, deadline: number) {
  const [t] = await sql`select prefs, start_date from pinpai.trips where id = ${tripId}`;
  const wants: string[] = (t?.prefs?.wants ?? []).filter((w: string) => WANT_Q[w]);
  if (!wants.length) return [] as string[];
  const all = await sql`select name, details->>'why' as why from pinpai.places where trip_id = ${tripId} and day_index is not null and category <> 'stay'`;
  const missing = wants.filter((w) => !all.some((r) => WANT_RE[w].test(`${r.name} ${r.why ?? ""}`)));
  if (!missing.length || onlyDay != null) return [];
  const { placesNear } = await import("./eats");
  const { sunTimes, tzOffsetMin } = await import("./geo");
  const hotelOn = await hotels(tripId);
  const full = Array.from({ length: nDays }, (_, d) => d).filter((d) => nDays <= 2 || (d > 0 && d < nDays - 1));
  const used = new Map<number, number>();
  const done: string[] = [];
  for (const w of missing) {
    if (Date.now() > deadline) break;
    const spec = WANT_Q[w];
    // the full day with the fewest extras so far, then the lightest day
    const loads = await Promise.all(full.map(async (d) => ({ d, n: (await loadDay(sql, tripId, d)).filter((r) => r.category !== "stay").length + (used.get(d) ?? 0) * 3 })));
    const day = loads.sort((a, b) => a.n - b.n)[0]?.d;
    if (day == null) continue;
    const rows = (await loadDay(sql, tripId, day)).filter((r) => r.category !== "stay");
    let at: number;
    // morning things start from where people slept, the rest from tonight's hotel
    const home = hotelOn(spec.at === "sunrise" || spec.near === "hotel" ? day - 1 : day);
    if (spec.at === "sunset" || spec.at === "sunrise") {
      const date = t?.start_date ? new Date(Date.parse(t.start_date) + day * 864e5).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      const p = home ?? rows.find((r) => r.lat != null);
      const sun = p ? sunTimes(Number(p.lat), Number(p.lng), date, tzOffsetMin(Number(p.lat), Number(p.lng), date)) : null;
      if (!sun) continue;
      at = spec.at === "sunset" ? hm(sun.set) - 30 : hm(sun.rise) - 20;
    } else at = spec.at;
    const before = rows.filter((r) => (hm2(r.start_time) ?? -1) <= at && r.lat != null).pop() ?? rows.find((r) => r.lat != null);
    const dayPts = rows.filter((r) => r.lat != null && r.category !== "transport");
    const homeOk = home && (!dayPts.length || dayPts.some((r) => kmBetween(r, home) <= 25));
    const near = spec.near === "hotel" && homeOk ? home : before ? { lat: before.lat!, lng: before.lng! } : homeOk ? home : null;
    if (!near) continue;
    // a map entry is not always a place a visitor goes: a sales office that lends bikes, a car park, a school
    const JUNK = /售楼|销售中心|sales (office|center|centre)|real estate|showroom|parking|停车|駐車|主車場|ที่จอดรถ|สำนักงานขาย|อสังหา|dormitory|staff only|office$/i;
    const list = (await placesNear(near, spec.q).catch(() => [])).filter((e) => !JUNK.test(e.name) && !(w === "massage" && /school|academy|โรงเรียน/i.test(e.name)));
    const e = list[0];
    if (!e) continue;
    const sort = before ? Number(before.sort_order) + 5 : 5;
    const hhmm = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
    await sql`insert into pinpai.places (trip_id, name, category, lat, lng, address, day_index, sort_order, start_time, duration_min, details, source)
      values (${tripId}, ${e.name.slice(0, 160)}, ${spec.cat}, ${e.lat}, ${e.lng}, ${e.address.slice(0, 300)}, ${day}, ${sort}, ${hhmm}, ${spec.dur},
        ${sql.json({ planned: true, kind: "want_fill", why: `${spec.th} ตามที่ขอไว้ · ใกล้${spec.near === "hotel" ? "ที่พัก" : "จุดก่อนหน้า"} (จากแผนที่ OpenStreetMap ยังไม่มีรีวิว)` } as never)}, 'ai')`;
    await renumber(tripId, day);
    await retimeStored(sql, tripId, day, { keepGaps: true });
    used.set(day, (used.get(day) ?? 0) + 1);
    done.push(`${w} → ${e.name} (D${day})`);
  }
  return done;
}

// ───────────────────────── day coherence ─────────────────────────
// The AI groups days by theme more than by map, so a day can zig-zag (Ubud → Uluwatu → Ubud) or hold one stop
// 40 km from the rest. This pass works from coordinates only:
//   1. a stop far from the rest of its day moves to a day that is already around there (or to "รอจัด");
//   2. the free sights between fixed points (meals, locked times, runs, sunrise/sunset, transport, hotel tasks)
//      are re-ordered for the shortest path, so the day stops backtracking;
//   3. days that still need a lot of travel are reported (the app offers "จัดวันนี้ใหม่").

const SUNLIT = /พระอาทิตย์(ขึ้น|ตก)|sunrise|sunset|日出|日落|夕阳|夕日|日の出|일출|일몰|해돋이/i;
const DAYTRIP = /day ?trip|เที่ยวไป-กลับ|ไปกลับ|นอกเมือง|ข้ามเกาะ|island hop|excursion|日帰り|一日游/i;

/** fixed points of a day: the reorder never moves these, and never moves anything across them */
function isAnchor(r: DayRow) {
  const k = r.details?.kind as string | undefined;
  return r.category === "stay" || r.category === "transport" || r.category === "food" || r.category === "cafe" || !!k
    || !!r.details?.fixed_time || r.visited || SUNLIT.test(`${r.name} ${String(r.details?.why ?? "")}`);
}

/** total straight-line path of a sequence (km), with optional start and end points */
function pathKm(seq: { lat: number | null; lng: number | null }[], from?: { lat: number; lng: number } | null, to?: { lat: number; lng: number } | null) {
  const pts = [...(from ? [from] : []), ...seq, ...(to ? [to] : [])].filter((p) => p.lat != null && p.lng != null);
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += kmBetween(pts[i - 1], pts[i]);
  return s;
}

/** best order of a short run of stops between two fixed points (exact up to 6 stops, nearest-neighbour + 2-opt beyond) */
function bestOrder<T extends { lat: number | null; lng: number | null }>(seg: T[], from: { lat: number; lng: number } | null, to: { lat: number; lng: number } | null): T[] {
  if (seg.length < 2) return seg;
  if (seg.length <= 6) {
    let best = seg, bestKm = pathKm(seg, from, to);
    const perm = (rest: T[], acc: T[]) => {
      if (!rest.length) { const k = pathKm(acc, from, to); if (k < bestKm - 1e-6) { bestKm = k; best = acc; } return; }
      for (let i = 0; i < rest.length; i++) perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
    };
    perm(seg, []);
    return best;
  }
  let order = [...seg];
  for (let improved = true, n = 0; improved && n < 50; n++) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
      const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
      if (pathKm(cand, from, to) < pathKm(order, from, to) - 0.05) { order = cand; improved = true; }
    }
  }
  return order;
}

export type DayFlag = { day: number; km: number; note: string };

export async function tightenDays(tripId: string, days: number, scope: Scope, deadline: number) {
  const notes: string[] = [];
  const flags: DayFlag[] = [];
  const [trip] = await sql`select prefs from pinpai.trips where id = ${tripId}`;
  const pace = String(trip?.prefs?.pace ?? "normal");
  const cap = pace === "relaxed" ? 4 : pace === "packed" ? 7 : 5;          // sights per day, meals not counted
  const hotelOn = await hotels(tripId);
  const inS = (d: number) => inScope(d, scope);
  const load = async () => {
    const all = new Map<number, DayRow[]>();
    for (let d = 0; d < days; d++) if (inS(d)) all.set(d, await loadDay(sql, tripId, d));
    return all;
  };
  let all = await load();
  // where each day really is: the robust middle of its sights (meals and tasks follow the sights, so they don't vote)
  const sightsOf = (rows: DayRow[]) => rows.filter((r) => r.lat != null && !["stay", "transport", "food", "cafe"].includes(r.category) && !r.details?.kind);
  const middle = (rows: DayRow[]) => {
    const pts = sightsOf(rows).map((r) => ({ lat: r.lat!, lng: r.lng! }));
    if (pts.length < 2) return null;
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    let c = { lat: med(pts.map((p) => p.lat)), lng: med(pts.map((p) => p.lng)) };
    const spread = med(pts.map((p) => kmBetween(p, c)));
    const core = pts.filter((p) => kmBetween(p, c) <= Math.max(5, spread * 3));
    if (core.length >= 2) c = { lat: med(core.map((p) => p.lat)), lng: med(core.map((p) => p.lng)) };
    return { c, spread: med(core.map((p) => kmBetween(p, c))) };
  };

  // 1) outliers: a sight far from the rest of its own day
  const touched = new Set<number>();
  for (const [d, rows] of all) {
    if (Date.now() > deadline) break;
    if (d === 0 || d === days - 1) continue;                          // arrival / departure days follow the flights
    const m = middle(rows);
    if (!m) continue;
    const limit = Math.max(12, m.spread * 3.5);
    for (const r of sightsOf(rows)) {
      if (!isAi(r) || isAnchor(r) || DAYTRIP.test(`${r.name} ${String(r.details?.why ?? "")}`)) continue;
      const far = kmBetween(r, m.c);
      if (far <= limit) continue;
      // a day that is already around there and still has room
      let target: number | null = null, bestKm = Infinity;
      for (const [d2, rows2] of all) {
        if (d2 === d || d2 === 0 || d2 === days - 1) continue;
        const m2 = middle(rows2);
        const k = m2 ? kmBetween(r, m2.c) : Infinity;
        if (k < Math.max(6, (m2?.spread ?? 0) * 2) && k < bestKm && sightsOf(rows2).length < cap) { bestKm = k; target = d2; }
      }
      if (target != null) {
        // slot it next to the nearest sight of that day (before its next fixed point), time worked out by retime
        const rows2 = all.get(target)!;
        const near = sightsOf(rows2).sort((a, b) => kmBetween(a, r) - kmBetween(b, r))[0];
        const sort = near ? near.sort_order + 5 : (rows2.at(-1)?.sort_order ?? 0) + 10;
        await sql`update pinpai.places set day_index = ${target}, sort_order = ${sort}, start_time = null, updated_at = now() where id = ${r.id} and trip_id = ${tripId}`;
        notes.push(`ย้าย ${r.name} ไปวันที่ ${target + 1} (อยู่โซนเดียวกัน แทนการนั่งรถ ~${Math.round(far)} กม.)`);
        touched.add(d); touched.add(target);
        rows2.push({ ...r, day_index: target, sort_order: sort, start_time: null });
      } else {
        await sql`update pinpai.places set day_index = null, start_time = null, sort_order = (select coalesce(max(sort_order), 0) + 10 from pinpai.places where trip_id = ${tripId} and day_index is null),
            details = coalesce(details, '{}'::jsonb) || ${sql.json({ why: `${String(r.details?.why ?? "").slice(0, 200)} · ย้ายมารอจัด: ไกลจากที่อื่นของวันนั้น ~${Math.round(far)} กม.` } as never)}, updated_at = now()
          where id = ${r.id} and trip_id = ${tripId}`;
        notes.push(`${r.name} ไกลจากที่อื่นของวันที่ ${d + 1} ~${Math.round(far)} กม. → ย้ายไปรอจัด`);
        touched.add(d);
      }
      all.set(d, (all.get(d) ?? []).filter((x) => x.id !== r.id));
    }
  }
  for (const d of touched) await renumber(tripId, d);
  if (touched.size) all = await load();

  // 2) shortest order for the free sights between fixed points
  for (const [d, rows] of all) {
    if (Date.now() > deadline) break;
    const start = hotelOn(d - 1), end = hotelOn(d);
    let changed = false;
    const out: DayRow[] = [];
    let seg: DayRow[] = [];
    let prev: { lat: number; lng: number } | null = start;
    const flush = (next: { lat: number; lng: number } | null) => {
      if (seg.length >= 2 && seg.every((r) => isAi(r))) {
        const better = bestOrder(seg, prev, next);
        if (better.some((r, i) => r.id !== seg[i].id) && pathKm(seg, prev, next) - pathKm(better, prev, next) > 1) { seg = better; changed = true; }
      }
      out.push(...seg);
      seg = [];
    };
    for (const r of rows) {
      if (isAnchor(r) || r.lat == null) {
        flush(r.lat != null ? { lat: r.lat, lng: r.lng! } : null);
        out.push(r);
        if (r.lat != null) prev = { lat: r.lat, lng: r.lng! };
      } else seg.push(r);
    }
    flush(end);
    if (!changed) continue;
    const moved = new Set(out.filter((r, i) => r.id !== rows[i].id).map((r) => r.id));
    await sql.begin(async (tx) => {
      for (let i = 0; i < out.length; i++) {
        const r = out[i];
        // a sight that moved gets its time from the new order; everything else keeps its time
        await tx`update pinpai.places set sort_order = ${(i + 1) * 10}, start_time = ${moved.has(r.id) ? null : r.start_time}, updated_at = now() where id = ${r.id} and trip_id = ${tripId}`;
      }
      await retimeStored(tx, tripId, d, { keepGaps: true });
    }).catch((e) => console.error("reorder", d, e));
    notes.push(`เรียงลำดับวันที่ ${d + 1} ใหม่ให้ไม่ย้อนไปมา`);
  }
  for (const d of touched) await sql.begin((tx) => retimeStored(tx, tripId, d, { keepGaps: true })).catch(() => {});

  // 3) how much moving each day still needs (straight line × road factor); heavy ones get flagged for the app
  all = await load();
  for (const [d, rows] of all) {
    const pts = rows.filter((r) => r.lat != null && r.category !== "stay");
    const km = Math.round(pathKm(pts, hotelOn(d - 1), d === days - 1 ? null : hotelOn(d)) * 1.3);
    const dayTrip = rows.some((r) => DAYTRIP.test(`${r.name} ${String(r.details?.why ?? "")}`));
    if (km > (dayTrip ? 220 : d === 0 || d === days - 1 ? 160 : 90)) flags.push({ day: d, km, note: dayTrip ? "เที่ยวไปกลับไกล" : "วันนี้นั่งรถเยอะ" });
  }
  return { notes, flags };
}

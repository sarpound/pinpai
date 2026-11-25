import { NextResponse, after } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { limitDb, requireHuman } from "@/lib/ratelimit";
import { handle, requireMember, readJson, str, num, assertUuid, HttpError } from "@/lib/auth";
import { planTrip, planOutline, settleDay, mealsNear, stopRules } from "@/lib/ai";
import { randomUUID } from "crypto";
import { notify } from "@/lib/push";
import { resolvePlace, medianOffset, distKm, sunTimes, tzOffsetMin, geocodeArea } from "@/lib/geo";
import { mapLimit, fillTripPhotos } from "@/lib/photos";
import { aiBudget } from "@/lib/limits";
import { rehomeHotels, rehomeStay } from "@/lib/hotels";
import { tightenDays, retimeStored, addHotelTasks, addRunRoutes, fillMissingMeals, tidyDays, ensureWants, inScope, type Scope } from "@/lib/dayplan";
import { verifyTripPlaces } from "@/lib/verify";
import { hourRule } from "@/lib/retime";

// a 7-day plan on the free AI tier can take ~2 min; leave room for geocoding + the fallback model
export const maxDuration = 300;

const STYLES = ["food", "cafe", "nature", "culture", "shopping", "nightlife", "family", "photo", "activity", "themepark", "market"];
const FOOD = ["local", "street", "famous", "seafood", "thai", "mild", "halal", "veg"];
const WHO = ["friends", "date", "family", "solo"];
const MEALS = ["breakfast", "lunch", "dinner", "snack", "late"];
const WANTS = ["run", "massage", "hike", "bike", "onsen", "beach", "show", "cooking", "sunrise", "sunset", "museum", "kids"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const norm = (s: string) => s.toLowerCase().replace(/[\s()\-.,'’]+/g, "");
// a trip longer than this is planned as an outline first, then CHUNK days per request (each request stays well under the 300 s limit)
const LONG = 7, CHUNK = 4, MAX_DAYS = 45;

/** One tap: plan the whole trip (days, meals, hotels, transport guide) and write it into the trip. */
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/plan">) {
  return handle(async () => {
    const { id } = await ctx.params;
    assertUuid(id);
    const body = await readJson(req);
    // long trips continue themselves: the previous block hands over with a one-time key (no user session in that request)
    const cont = typeof body.continue === "string" ? body.continue : null;
    let me: { id: string; name: string };
    let job0: Record<string, unknown> | null = null;
    if (cont) {
      const fresh = randomUUID();
      const [claimed] = await sql`update pinpai.trips set plan_job = plan_job || ${sql.json({ nonce: fresh, started_at: new Date().toISOString(), waiting: false } as never)}
        where id = ${id} and plan_job->>'state' = 'running' and plan_job->>'nonce' = ${cont} returning plan_job`;
      if (!claimed) throw new HttpError(409, "stale continuation");
      job0 = claimed.plan_job;
      me = { id: String(job0!.by_id ?? ""), name: String(job0!.by ?? "") };
    } else {
      me = await requireMember(req, id);
      // a fresh plan spends real money: people only (BotID), and a sane pace per person across all instances
      await requireHuman(req);
      await limitDb(req, "plan", [{ max: 8, windowSec: 600 }, { max: 30, windowSec: 86400 }], "กดจัดทริปถี่เกินไป รอสักครู่แล้วลองใหม่");
    }
    const [trip] = await sql`select destination, dest_lat::float8 as lat, dest_lng::float8 as lng, start_date::text, end_date::text, prefs as cur_prefs, guide from pinpai.trips where id = ${id}`;
    if (!trip.destination) throw new HttpError(400, "ใส่จุดหมายของทริปก่อน");
    if (!trip.start_date || !trip.end_date) throw new HttpError(400, "ตั้งวันไป–กลับก่อน แล้วค่อยให้จัดทริป");
    const days = Math.round((Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 864e5) + 1;
    if (days > MAX_DAYS) throw new HttpError(400, `ทริปยาว ${days} วัน ระบบจัดให้ได้ทีละไม่เกิน ${MAX_DAYS} วัน แบ่งเป็น 2 ทริปก่อนนะ`);
    // "จัดเฉพาะวันนี้": re-plan one day with the trip's saved preferences, leave every other day alone
    const od = num(body.only_day);
    const onlyDay = cont ? null : od != null && od >= 0 && od < days ? Math.floor(od) : null;
    const b = cont ? (trip.cur_prefs ?? {}) : onlyDay != null ? { ...(trip.cur_prefs ?? {}), ...body, must: null } : body;
    const prefs = {
      styles: Array.isArray(b.styles) ? (b.styles as string[]).filter((s) => STYLES.includes(s)).slice(0, 6) : [],
      pace: ["relaxed", "normal", "packed"].includes(b.pace as string) ? (b.pace as string) : "normal",
      budget: ["budget", "mid", "luxury"].includes(b.budget as string) ? (b.budget as string) : "mid",
      mode: ["transit", "taxi", "drive", "walk"].includes(b.mode as string) ? (b.mode as string) : "taxi",
      travelers: Math.max(1, Math.min(20, Math.round(num(b.travelers) ?? 2))),
      note: str(b.note, 300),
      companions: WHO.includes(b.companions as string) ? (b.companions as string) : "friends",
      food: Array.isArray(b.food) ? FOOD.filter((f) => (b.food as string[]).includes(f)) : [],
      must: str(b.must, 300),
      meals: Array.isArray(b.meals) ? MEALS.filter((m) => (b.meals as string[]).includes(m)) : ["breakfast", "lunch", "dinner"],
      wants: Array.isArray(b.wants) ? WANTS.filter((w) => (b.wants as string[]).includes(w)) : [],
      arrive_time: typeof b.arrive_time === "string" && HHMM.test(b.arrive_time) ? b.arrive_time : null,
      depart_time: typeof b.depart_time === "string" && HHMM.test(b.depart_time) ? b.depart_time : null,
    };
    // no time typed in the form → use what members entered under "เที่ยวบิน/แยกย้าย" (latest arrival, earliest departure)
    if (!prefs.arrive_time || !prefs.depart_time) {
      const tv = await sql`select travel from pinpai.members where trip_id = ${id} and travel is not null`;
      const pick = (k: "arrive" | "depart") => tv.map((r) => r.travel?.[k]?.time as string | undefined).filter((t): t is string => !!t && HHMM.test(t)).sort();
      const a = pick("arrive"), d = pick("depart");
      if (!prefs.arrive_time && a.length) prefs.arrive_time = a[a.length - 1];
      if (!prefs.depart_time && d.length) prefs.depart_time = d[0];
    }
    const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    // be at the airport/station 2.5 h before leaving; with no time given, the last day winds down by 17:00
    const leaveBy = prefs.depart_time ? Math.max(8 * 60, hm(prefs.depart_time) - 150) : 17 * 60;
    // money cap: from the wizard or the trip's saved budget, normalised to per person
    const bAmt = num(b.budget_amount) ?? trip.cur_prefs?.budget_amount ?? null;
    const bPer = b.budget_per === "group" || b.budget_per === "person" ? b.budget_per : trip.cur_prefs?.budget_per ?? "person";
    const budgetTHB = bAmt && bAmt > 0 ? (bPer === "group" ? bAmt / prefs.travelers : bAmt) : null;
    const money = bAmt && bAmt > 0 ? { budget_amount: Math.round(bAmt), budget_per: bPer } : {};
    const existing = await sql`select id, name, day_index, category, lat::float8 as lat, lng::float8 as lng, start_time,
      coalesce((details->>'fixed_time')::boolean, false) as fixed, details ? 'user_edited' as edited from pinpai.places p
      where trip_id = ${id} and coalesce(details->>'kind', '') not in ('hotel_task', 'run', 'meal_fill')
        -- only what people own: their own adds, edits, locks, votes, ticks. The previous AI plan is replaced, not re-fed to the AI
        and (source <> 'ai' or coalesce(details->>'planned', '') <> 'true' or visited or details ? 'user_edited' or coalesce((details->>'fixed_time')::boolean, false)
          or exists (select 1 from pinpai.votes v where v.place_id = p.id))`;
    const exById = new Map(existing.map((e) => [e.id as string, e]));
    // everything on the trip (incl. the previous AI plan): for the hotel and "don't repeat other days" on a single-day re-plan
    const allPlaces = await sql`select name, day_index, category from pinpai.places where trip_id = ${id} and coalesce(details->>'kind', '') not in ('hotel_task', 'run', 'meal_fill')`;
    const meter = await aiBudget(id, "plan", cont ? undefined : req);
    const chunked = onlyDay == null && days > LONG;
    const chunks: [number, number][] = [];
    for (let d = 0; d < days; d += CHUNK) chunks.push([d, Math.min(days - 1, d + CHUNK - 1)]);
    // one planner at a time per trip; a job older than 6 min is considered dead (function timed out)
    type Job = { state: string; by: string; by_id: string; started_at: string; days: number; only_day?: number; chunked?: boolean; chunks?: [number, number][];
      next?: number; nonce?: string; outlined?: boolean; waiting?: boolean; retries?: number; done_days?: number; added?: number; moved?: number; removed?: number; message?: string };
    let job: Job;
    if (cont) job = { ...(job0 as Job), waiting: false };
    else {
      job = { state: "running", by: me.name, by_id: me.id, started_at: new Date().toISOString(), days, ...(onlyDay != null ? { only_day: onlyDay } : {}),
        ...(chunked ? { chunked: true, chunks, next: 0, nonce: randomUUID(), done_days: 0, added: 0, moved: 0, removed: 0 } : {}) };
      const locked = await sql`update pinpai.trips set plan_job = ${sql.json(job as never)} where id = ${id}
        and (plan_job is null or plan_job->>'state' <> 'running' or (plan_job->>'started_at')::timestamptz < now() - interval '6 minutes') returning id`;
      if (!locked.length) {
        const [cur] = await sql`select plan_job from pinpai.trips where id = ${id}`;
        throw new HttpError(409, `${cur?.plan_job?.by ?? "เพื่อน"} กำลังให้ระบบจัดทริปอยู่ รอสักครู่ เดี๋ยวแผนขึ้นเอง`);
      }
    }
    // remember the choices right away, so they come back even if this run fails or the app is closed
    if (onlyDay == null && !cont) await sql`update pinpai.trips set prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ ...prefs, ...money } as never)} where id = ${id}`;
    await bumpVersion(id);
    // the heavy part runs after we answer: closing the app, going back or losing signal won't stop it
    after(async () => {
      // never leave the trip stuck on "running": if the platform is about to stop us, say so first
      const watchdog = setTimeout(() => {
        // a block of a long trip that ran out of time is offered again (an open app picks it up); anything else is reported
        const retry = job.chunked && (job.retries ?? 0) < 2;
        const nxt = retry ? { ...job, retries: (job.retries ?? 0) + 1, nonce: randomUUID(), waiting: true, started_at: new Date().toISOString() }
          : { ...job, state: "error", finished_at: new Date().toISOString(), message: "ใช้เวลานานเกินไป ลองลดจำนวนวันหรือกดจัดใหม่อีกครั้ง" };
        sql`update pinpai.trips set plan_job = ${sql.json(nxt as never)}
          where id = ${id} and plan_job->>'started_at' = ${job.started_at} and plan_job->>'state' = 'running'`.then(() => bumpVersion(id)).catch(() => {});
      }, 285_000);
      try {
        if (job.chunked) {
          const t0 = Date.now();
          // hand over to a fresh request (own 300 s budget); the key changes so each step runs exactly once
          // the platform stops a request chain after a few hops (508 loop detected): then the next block waits for any open app
          // of the group to start it (the trip screen does that by itself), so nothing is lost
          const handOver = async (patch: Partial<Job>) => {
            const nonce = randomUUID();
            const next = { ...job, ...patch, nonce, waiting: true, started_at: new Date().toISOString() };
            await sql`update pinpai.trips set plan_job = ${sql.json(next as never)} where id = ${id} and plan_job->>'nonce' = ${job.nonce!}`;
            clearTimeout(watchdog);
            await bumpVersion(id).catch(() => {});
            const res = await fetch(new URL(`/api/trips/${id}/plan`, req.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ continue: nonce }) }).catch((e) => e as Error);
            if (res instanceof Error || !res.ok) console.warn(`[plan] self-continue ${res instanceof Error ? res.message : res.status} — waiting for an open app`);
          };
          if (!job.outlined) {
            await runOutline();
            await handOver({ outlined: true, message: `วางเส้นทาง ${days} วันแล้ว กำลังจัดรายวัน` });
            return;
          }
          const k = job.next ?? 0;
          const [from, to] = job.chunks![k];
          const r = await runPlan([from, to], t0);
          // a block that came back with an empty / one-stop day (the model skipped a day): plan the block once more
          const thin = await sql`select g.d from generate_series(${Math.max(1, from)}::int, ${Math.min(to, days - 2)}::int) g(d)
            where (select count(*) from pinpai.places p where p.trip_id = ${id} and p.day_index = g.d and p.category <> 'stay'
              and coalesce(p.details->>'kind', '') not in ('hotel_task', 'run')) < 2`;
          if (thin.length && (job.retries ?? 0) < 1) throw new Error(`thin days ${thin.map((x) => x.d).join(",")}`);
          const acc = { added: (job.added ?? 0) + r.added, moved: (job.moved ?? 0) + r.moved, removed: (job.removed ?? 0) + r.removed, done_days: to + 1 };
          if (k + 1 < job.chunks!.length) {
            await handOver({ ...acc, next: k + 1, retries: 0, message: `จัดแล้ว ${to + 1}/${days} วัน` });
            return;
          }
          // last block: activities still missing anywhere in the trip
          await ensureWants(id, days, null, t0 + 270_000).catch((e) => console.error("wants", e));
          await sql`update pinpai.trips set plan_job = ${sql.json({ ...job, ...acc, state: "done", finished_at: new Date().toISOString(), message: null } as never)} where id = ${id}`;
          await logActivity(id, me.id, `${me.name} ให้ระบบจัดทริป ${days} วัน (${acc.added} ที่ใหม่)`);
        } else {
          const r = await runPlan(onlyDay, Date.now());
          await sql`update pinpai.trips set plan_job = ${sql.json({ ...job, state: "done", finished_at: new Date().toISOString(), ...r } as never)} where id = ${id}`;
          await logActivity(id, me.id, onlyDay != null ? `${me.name} ให้ระบบจัดวันที่ ${onlyDay + 1} ใหม่ (${r.added} ที่ใหม่)` : `${me.name} ให้ระบบจัดทริป ${days} วัน (${r.added} ที่ใหม่)`);
        }
      } catch (e) {
        console.error("[plan] failed", e);
        // a block of a long trip that hit a busy AI: try the same block again in a moment (twice), the days already done stay
        if (job.chunked && (job.retries ?? 0) < 2) {
          clearTimeout(watchdog);
          await new Promise((r) => setTimeout(r, 30_000));
          const nonce = randomUUID();
          await sql`update pinpai.trips set plan_job = ${sql.json({ ...job, retries: (job.retries ?? 0) + 1, nonce, waiting: true, started_at: new Date().toISOString() } as never)}
            where id = ${id} and plan_job->>'nonce' = ${job.nonce!}`.catch(() => {});
          await bumpVersion(id).catch(() => {});
          await fetch(new URL(`/api/trips/${id}/plan`, req.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ continue: nonce }) }).catch(() => {});
          return;
        }
        const msg = /\bAI\b|Gateway|rate.?limit|429|model/.test(String(e)) ? "ระบบ AI ไม่ว่างชั่วคราว ลองกดจัดใหม่อีกครั้ง" : "จัดทริปไม่สำเร็จ ลองใหม่อีกครั้ง";
        await sql`update pinpai.trips set plan_job = ${sql.json({ ...job, state: "error", finished_at: new Date().toISOString(), message: msg } as never)} where id = ${id}`.catch(() => {});
      }
      clearTimeout(watchdog);
      const [fin] = await sql`select plan_job->>'state' as state, title from pinpai.trips where id = ${id}`.catch(() => []);
      if (fin?.state === "done") await notify(id, { title: fin.title ?? "ปักไป", body: onlyDay != null ? `จัดวันที่ ${onlyDay + 1} ใหม่เสร็จแล้ว แตะเพื่อดู` : `จัดทริป ${days} วันเสร็จแล้ว 🎉 แตะเพื่อดูแผน`, tag: `plan-${id}` });
      else if (fin?.state === "error") await notify(id, { title: fin.title ?? "ปักไป", body: "จัดทริปไม่สำเร็จ แตะเพื่อลองใหม่", tag: `plan-${id}` }, { to: me.id });
      await bumpVersion(id).catch(() => {});
      for (let i = 0; i < 4; i++) { const r = await fillTripPhotos(id, 12).catch(() => ({ remaining: 0 })); if (!r.remaining) break; }
    });
    return NextResponse.json({ started: true, days }, { status: 202 });

    /** the long-trip outline: route of bases, a hotel per base, one area per day; saved places get their day; the old AI plan goes */
    async function runOutline() {
      const t0Outline = Date.now();
      const o = await planOutline({ destination: trip.destination, days, startDate: trip.start_date, ...prefs, budgetTHB,
        existing: existing.map((e) => ({ name: e.name, day: e.day_index })) }, meter);
      const anchor = trip.lat != null ? { lat: trip.lat, lng: trip.lng } : null;
      // a country-wide trip ("Thailand", "Japan") has a centroid nobody visits: find each base city first, then its hotel near it
      const baseNames = [...new Set(o.days.map((d) => d.base))].slice(0, 15);
      const basePt = new Map<string, { lat: number; lng: number }>();
      await mapLimit(baseNames, 3, async (b) => {
        // a city / island / province, not a shop that happens to share the name ("Chiang Mai" noodle bar near Bangkok)
        const same = b.toLowerCase().includes(String(trip.destination).toLowerCase());
        const hit = (!same ? await geocodeArea(`${b}, ${trip.destination}`).catch(() => null) : null) ?? await geocodeArea(b).catch(() => null);
        if (hit && (!anchor || distKm(hit, anchor) < 2500)) basePt.set(b, { lat: hit.lat, lng: hit.lng });
      });
      const stays = await mapLimit(o.stays, 4, async (st) => {
        const base = o.days.find((d) => d.day === Math.round(st.check_in_day))?.base;
        const city = (base ? basePt.get(base) : undefined) ?? anchor;
        const g = st.lat != null && st.lng != null ? { lat: st.lat, lng: st.lng } : null;
        const guess = g && (!city || distKm(g, city) <= 40) ? g : null;     // the model's pin only if it is in that city
        const loc = await resolvePlace(st.name_local ?? st.name, null, guess ?? city, 25, { anchor: city, areaKm: 40, alt: st.name_local ? st.name : null, category: "stay" }).catch(() => null);
        return { st, loc: loc ?? (guess ?? city ? { ...(guess ?? city)!, address: "", approx: true } : null) };
      });
      await sql.begin(async (tx) => {
        await tx`delete from pinpai.places p where p.trip_id = ${id} and p.source = 'ai' and coalesce(p.details->>'planned', '') = 'true'
          and not p.visited and not (p.details ? 'user_edited') and not exists (select 1 from pinpai.votes v where v.place_id = p.id)`;
        for (const { st, loc } of stays) {
          const label = st.name_local && st.name_local !== st.name ? `${st.name_local} (${st.name})` : st.name;
          await tx`insert into pinpai.places (trip_id, name, category, lat, lng, address, day_index, sort_order, details, source, added_by)
            values (${id}, ${label.slice(0, 160)}, 'stay', ${loc?.lat ?? null}, ${loc?.lng ?? null}, ${loc?.address ?? null}, ${Math.round(st.check_in_day)}, 0,
              ${sql.json({ why: `${st.area} · ${st.price} · ${st.why}`, nights: st.nights, planned: true, ...(loc?.approx ? { approx: true } : {}) } as never)}, 'ai', ${me.id})`;
        }
        // places the group saved without a day go to the day whose area they belong to
        for (const a of o.assign ?? []) {
          const e = existing.find((x) => x.day_index == null && norm(x.name) === norm(a.name));
          if (e && a.day >= 0 && a.day < days) await tx`update pinpai.places set day_index = ${Math.round(a.day)} where id = ${e.id} and trip_id = ${id} and day_index is null`;
        }
        const guide = { summary: o.summary, getting_there: o.getting_there, getting_around: o.getting_around, tips: o.tips,
          prep: (o.prep ?? []).map((t) => String(t).replace(/[:：]?\s*\+?\d[\d\s().-]{7,}\d/g, " (เช็กเบอร์ล่าสุดจากเว็บทางการ)").trim().slice(0, 200)).filter(Boolean).slice(0, 10),
          themes: Object.fromEntries(o.days.map((d) => [d.day, d.theme])),
          outline: o.days.map((d) => ({ day: d.day, base: d.base, area: d.area, ...(basePt.get(d.base) ?? {}) })),
          generated_at: new Date().toISOString(),
          costs: o.costs ? Object.fromEntries(Object.entries(o.costs).map(([k, v]) => [k, typeof v === "number" ? Math.max(0, Math.round(v)) : v])) : undefined };
        await tx`update pinpai.trips set guide = ${sql.json(guide as never)} where id = ${id}`;
      });
      // the outline already says which district each day is in: put each hotel near the middle of its days' districts
      // now, before any day is planned around it (a day trip 60 km out doesn't pull the hotel)
      try {
        const areaPt = new Map<string, { lat: number; lng: number }>();
        const areas = [...new Set(o.days.map((d) => `${d.area}|${d.base}`))].slice(0, 16);
        for (const key of areas) {
          if (Date.now() > t0Outline + 120_000) break;
          const [area, base] = key.split("|");
          const bp = basePt.get(base) ?? anchor;
          const hit = await geocodeArea(`${area.replace(/\(.*?\)/g, "").trim()}, ${base}`).catch(() => null);
          if (hit && (!bp || distKm(hit, bp) < 40)) areaPt.set(key, { lat: hit.lat, lng: hit.lng });
        }
        const rows = await sql`select id, name, day_index, lat::float8 as lat, lng::float8 as lng from pinpai.places
          where trip_id = ${id} and category = 'stay' and source = 'ai' and day_index is not null order by day_index`;
        for (let i = 0; i < rows.length; i++) {
          const from = rows[i].day_index as number, to = (rows[i + 1]?.day_index ?? days) as number;
          const pts = o.days.filter((d) => d.day >= from && d.day <= Math.min(days - 1, to)).map((d) => areaPt.get(`${d.area}|${d.base}`)).filter((x): x is { lat: number; lng: number } => !!x);
          const r = await rehomeStay(id, rows[i] as never, pts, prefs.budget, t0Outline + 150_000);
          if (r) console.log("rehome (outline)", `${r.from} → ${r.to}`);
        }
      } catch (e) { console.error("rehome outline", e); }
    }

    async function runPlan(sc: Scope, t0: number) {
      const rg = Array.isArray(sc) ? sc : null;
      const lo = sc == null ? null : typeof sc === "number" ? sc : sc[0], hi = sc == null ? null : typeof sc === "number" ? sc : sc[1];
      // a day or a block of days: keep what people picked on those days, don't repeat other days
      const fixed = lo == null ? [] : await sql`select p.name, p.day_index, p.start_time, coalesce((p.details->>'fixed_time')::boolean, false) as fixed from pinpai.places p
        where p.trip_id = ${id} and p.day_index between ${lo} and ${hi} and p.category <> 'stay'
        and (p.source <> 'ai' or coalesce(p.details->>'planned', '') <> 'true' or p.visited or p.details ? 'user_edited'
          or exists (select 1 from pinpai.votes v where v.place_id = p.id))`;
      // the hotel(s) as they are now (a long trip's outline wrote them a moment ago)
      const stayRows = lo == null ? [] : await sql`select name, day_index, lat::float8 as lat, lng::float8 as lng from pinpai.places where trip_id = ${id} and category = 'stay' order by day_index nulls first`;
      const stayOn = (d: number) => stayRows.filter((e) => (e.day_index ?? 0) <= d).pop() ?? stayRows[0];
      const hotel = lo == null ? null : stayOn(lo);
      const dayDate = lo != null ? new Date(Date.parse(trip.start_date) + lo * 864e5).toISOString().slice(0, 10) : trip.start_date;
      const outline: { day: number; base: string; area: string; lat?: number; lng?: number }[] = (await sql`select guide->'outline' as o from pinpai.trips where id = ${id}`)[0]?.o ?? [];
      const themes: Record<string, string> = (await sql`select guide->'themes' as t from pinpai.trips where id = ${id}`)[0]?.t ?? {};
      const others = (await sql`select name from pinpai.places where trip_id = ${id} and day_index is not null and category <> 'stay'
        and coalesce(details->>'kind', '') not in ('hotel_task', 'run', 'meal_fill') and not (day_index between ${lo ?? -1} and ${hi ?? -1})`).map((e) => e.name as string);
      const plan = await planTrip({
        destination: trip.destination, days: lo != null ? hi! - lo + 1 : days, startDate: dayDate, ...prefs, budgetTHB,
        deadline: t0 + 170_000,
        sun: trip.lat != null ? sunTimes(trip.lat, trip.lng, dayDate, tzOffsetMin(trip.lat, trip.lng, dayDate)) : null,
        existing: lo != null ? fixed.map((e) => ({ name: e.name, day: e.day_index, category: "attraction", time: e.fixed ? e.start_time : null }))
          : existing.map((e) => ({ name: e.name, day: e.day_index, category: e.category, time: e.fixed && e.day_index != null ? e.start_time : null })),
        ...(onlyDay != null ? { single: { day: onlyDay, total: days, hotel: hotel?.name ?? null, avoid: others } } : {}),
        ...(rg ? { range: { from: rg[0], to: rg[1], total: days, avoid: others,
          brief: Array.from({ length: rg[1] - rg[0] + 1 }, (_, i) => rg[0] + i).map((d) => { const o = outline.find((x) => x.day === d);
            return { day: d, base: o?.base ?? trip.destination, area: o?.area ?? trip.destination, theme: themes[d] ?? "", hotel: stayOn(d)?.name ?? null }; }) } } : {}),
      }, meter);

      const tripAnchor = trip.lat != null ? { lat: trip.lat, lng: trip.lng } : null;
      // where a day happens: its base city (long trips) or the destination — map searches are biased to it
      const dayAnchor = (d: number) => { const o = outline.find((x) => x.day === d); return o?.lat != null && o?.lng != null ? { lat: o.lat, lng: o.lng } : tripAnchor; };
      const anchor = lo != null ? dayAnchor(lo) : tripAnchor;
      // a day / block: only re-use places from those days or the wishlist, never steal a stop from another day
      const byName = new Map(existing.filter((e) => sc == null || e.day_index == null || inScope(e.day_index, sc)).map((e) => [norm(e.name), e]));
      type Item = { name: string; name_local: string | null; category: string; lat: number | null; lng: number | null; why: string;
        day: number; order: number; start_time: string | null; duration_min: number | null; nights?: number; price?: string };
      const items: Item[] = [];
      plan.days.forEach((d) => d.stops.forEach((s, i) => items.push({ ...s, day: d.day, order: i, start_time: /^\d{1,2}:\d{2}$/.test(s.start_time) ? s.start_time.padStart(5, "0") : null })));
      plan.stays.forEach((s) => items.push({ name: s.name, name_local: s.name_local, category: "stay", lat: s.lat, lng: s.lng, why: `${s.area} · ${s.price} · ${s.why}`,
        day: Math.max(0, Math.min(days - 1, Math.round(s.check_in_day))), order: -1, start_time: null, duration_min: null, nights: s.nights, price: s.price }));

      // match places the group already saved; geocode the rest (bounded concurrency — free OSM services)
      type Res = { it: Item; label: string; existingId: string | null; loc: { lat: number; lng: number; address: string; approx: boolean } | null; pt: { lat: number; lng: number } | null; misfit?: { lat: number; lng: number } };
      const labelOf = (it: Item) => {
        const ln = it.name_local?.trim(), en = it.name.trim();
        // avoid "ร้าน A (ร้าน A (Shop A))" when the AI already put both names in one field
        return !ln || ln === en ? en : ln.includes(en) ? ln : en.includes(ln) ? en : `${ln} (${en})`;
      };
      const eats = (it: Item) => it.category === "food" || it.category === "cafe";
      const lookup = async (it: Item, near: { lat: number; lng: number } | null): Promise<Res> => {
        const label = labelOf(it);
        const ex = byName.get(norm(label)) ?? byName.get(norm(it.name)) ?? (it.name_local ? byName.get(norm(it.name_local)) : undefined);
        if (ex) return { it, label, existingId: ex.id as string, loc: null, pt: ex.lat != null ? { lat: ex.lat, lng: ex.lng } : null };
        const guess = it.lat != null && it.lng != null ? { lat: it.lat, lng: it.lng } : null;
        // out of time: keep the AI's point (the pin self-heals when the trip is opened)
        if (Date.now() - t0 > 250_000) return { it, label, existingId: null, loc: guess ? { ...guess, address: "", approx: true } : null, pt: guess };
        const anc = dayAnchor(it.day);
        const opt = { anchor: anc, alt: it.name_local ? it.name : null, category: it.category };
        if (near) {
          // a restaurant is looked up around the stop it sits next to: nearest branch of a chain, never a cross-town lunch
          const hit = await resolvePlace(it.name_local ?? it.name, null, near, 4, { ...opt, nearest: true });
          if (hit && !hit.approx && distKm(hit, near) <= 6) return { it, label, existingId: null, loc: hit, pt: { lat: hit.lat, lng: hit.lng } };
          if (guess && distKm(guess, near) <= 5) return { it, label, existingId: null, loc: { ...guess, address: "", approx: true }, pt: guess };
          // this restaurant is simply not around here → replaced below by one that is
          return { it, label, existingId: null, loc: null, pt: null, misfit: near };
        }
        const loc = await resolvePlace(it.name_local ?? it.name, null, guess ?? anc, guess ? 12 : 80, opt);
        return { it, label, existingId: null, loc, pt: loc ? { lat: loc.lat, lng: loc.lng } : null };
      };
      const first = await mapLimit(items.filter((it) => !eats(it)), 6, (it) => lookup(it, null));
      const solid = (r: Res) => !!r.pt && !(r.loc?.approx);
      // the AI's coordinates are often shifted the same way for the whole plan
      const off = medianOffset(first.filter((r) => solid(r) && r.loc && r.it.lat != null && r.it.lng != null).map((r) => ({ guess: { lat: r.it.lat!, lng: r.it.lng! }, real: r.pt! })));
      const guessOf = (r: Res) => (r.it.lat != null && r.it.lng != null ? { lat: r.it.lat + (off?.dLat ?? 0), lng: r.it.lng + (off?.dLng ?? 0) } : null);
      const shifted = new Set<Res>();
      if (off) for (const r of first) if (r.loc?.approx && guessOf(r)) { const g = guessOf(r)!; r.loc = { ...r.loc, ...g }; r.pt = g; shifted.add(r); }
      const median = (rs: Res[]) => { const m = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]; return { lat: m(rs.map((r) => r.pt!.lat)), lng: m(rs.map((r) => r.pt!.lng)) }; };
      const dayIds = [...new Set(items.map((it) => it.day))];
      // a pin that lands far from the rest of its day while the AI meant somewhere close is a wrong match ("Nanjing Road" in another city)
      for (const d of dayIds) {
        const day = first.filter((r) => r.it.day === d && r.it.category !== "stay" && r.pt && !r.existingId);
        for (const r of day) {
          const others = day.filter((o) => o !== r);
          const g = guessOf(r);
          if (others.length < 2 || !solid(r)) continue;
          const med = median(others);
          // far from the rest of its day: unless the AI itself meant it to be far (a real day trip), look again near the day
          if (distKm(r.pt!, med) <= 15 || (g && distKm(g, med) > 25 && distKm(g, r.pt!) <= 12)) continue;
          const name = r.it.name_local ?? r.it.name, alt = r.it.name_local ? r.it.name : null;
          const again = (g && distKm(g, med) <= 25 ? await resolvePlace(name, null, g, 10, { alt, category: r.it.category, strict: true }).catch(() => null) : null)
            ?? await resolvePlace(name, null, med, 15, { alt, category: r.it.category, strict: true, nearest: true }).catch(() => null);
          if (again) { r.loc = again; r.pt = { lat: again.lat, lng: again.lng }; continue; }
          const fallback = g && distKm(g, med) <= 25 ? g : null;
          if (fallback) { r.loc = { ...fallback, address: "", approx: true }; r.pt = fallback; shifted.add(r); }
        }
      }
      // walk the day in a line: re-order the sights (not meals, airports, timed moments) by nearest neighbour when that is clearly shorter
      const TIMED = /วิ่ง|\brun|jog|sunrise|sunset|พระอาทิตย์|show|โชว์|cruise|ล่องเรือ|night|กลางคืน|ยามค่ำ/i;
      const hotelPt = first.find((r) => r.it.category === "stay" && r.pt)?.pt ?? (hotel?.lat != null ? { lat: hotel.lat, lng: hotel.lng } : null);
      for (const d of dayIds) {
        const seq = first.filter((r) => r.it.day === d && r.it.category !== "stay").sort((x, y) => x.it.order - y.it.order);
        const mov = seq.filter((r) => r.pt && r.it.category !== "transport" && !TIMED.test(`${r.label} ${r.it.why ?? ""}`) && (r.it.duration_min ?? 0) < 300);
        if (mov.length < 3) continue;
        const before = seq.filter((r) => r.pt && r.it.order < mov[0].it.order).pop();
        const start = before?.pt ?? hotelPt ?? mov[0].pt!;
        const len = (list: Res[]) => list.reduce((n, r, i) => n + distKm(i ? list[i - 1].pt! : start, r.pt!), 0);
        const left = [...mov], path: Res[] = [];
        let cur = start;
        while (left.length) { left.sort((x, y) => distKm(cur, x.pt!) - distKm(cur, y.pt!)); const nx = left.shift()!; path.push(nx); cur = nx.pt!; }
        if (len(path) > len(mov) * 0.8) continue;
        const slots = mov.map((r) => ({ order: r.it.order, start_time: r.it.start_time }));
        path.forEach((r, i) => { r.it.order = slots[i].order; r.it.start_time = slots[i].start_time; });
      }
      const second = await mapLimit(items.filter(eats), 6, (it) => {
        const same = first.filter((r) => r.it.day === it.day && r.it.category !== "stay" && r.it.category !== "transport" && r.pt);
        const prev = same.filter((r) => r.it.order < it.order).sort((x, y) => y.it.order - x.it.order)[0];
        const next = same.filter((r) => r.it.order > it.order).sort((x, y) => x.it.order - y.it.order)[0];
        // breakfast belongs near the hotel; other meals next to the stop before them
        const near = (!prev && hotelPt && next && distKm(hotelPt, next.pt!) < 8 ? hotelPt : (prev ?? next)?.pt) ?? hotelPt;
        return lookup(it, near ?? null);
      });
      // restaurants that turned out to be across town → ask once for real ones around the actual pins
      const misfits = second.filter((r) => r.misfit).slice(0, 10);
      if (misfits.length && Date.now() - t0 < 215_000) {
        const nameAt = (pt: { lat: number; lng: number }) => first.filter((r) => r.pt).sort((x, y) => distKm(x.pt!, pt) - distKm(y.pt!, pt))[0]?.it.name ?? "the hotel";
        const mealOf = (t: string | null) => { const h = t ? Number(t.slice(0, 2)) : 12; return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 17 ? "snack" : "dinner"; };
        try {
          const got = await mealsNear({ destination: trip.destination, companions: prefs.companions, food: prefs.food, note: prefs.note },
            misfits.map((r, i) => ({ day: i, meal: mealOf(r.it.start_time), around: `${nameAt(r.misfit!)} (${r.misfit!.lat.toFixed(5)},${r.misfit!.lng.toFixed(5)}) — within 1 km` })), meter);
          await mapLimit(misfits, 5, async (r) => {
            const g = got.find((x) => x.day === misfits.indexOf(r));
            if (!g) return;
            const near = r.misfit!;
            const hit = await resolvePlace(g.name_local ?? g.name, null, near, 4, { anchor, alt: g.name_local ? g.name : null, category: "food", nearest: true }).catch(() => null);
            const ai = g.lat != null && g.lng != null && distKm({ lat: g.lat, lng: g.lng }, near) <= 4 ? { lat: g.lat, lng: g.lng } : null;
            const pt = hit && !hit.approx && distKm(hit, near) <= 6 ? { lat: hit.lat, lng: hit.lng, address: hit.address, approx: false } : ai ? { ...ai, address: "", approx: true } : null;
            if (!pt) return;
            r.it = { ...r.it, name: g.name, name_local: g.name_local, why: g.why };
            r.label = labelOf(r.it); r.loc = pt; r.pt = { lat: pt.lat, lng: pt.lng }; r.misfit = undefined;
          });
        } catch { /* fall through: the day view offers "ยังไม่มีมื้อ…" for the ones we drop */ }
      }
      const resolved = [...first, ...second.filter((r) => !r.misfit)];
      // last checks on real pins (the model breaks these even when told): spicy for a no-spicy group, made-up "local breakfast stall"
      // names the map can't find, and out-of-town trips on the departure day
      const noSpicy = stopRules.noSpicy(prefs.note, prefs.food);
      // what people placed by hand stays on its day; a locked time is kept exactly
      for (const r of resolved) {
        const e = r.existingId ? exById.get(r.existingId) : null;
        if (!e) continue;
        if ((e.edited || e.fixed) && e.day_index != null && inScope(e.day_index, sc)) r.it.day = e.day_index;
        if (e.fixed && e.start_time) { r.it.start_time = String(e.start_time).slice(0, 5); (r.it as { fixed?: boolean }).fixed = true; }
      }
      const hotelAt = resolved.find((r) => r.it.category === "stay" && r.pt)?.pt ?? (hi != null && stayOn(hi)?.lat != null ? { lat: stayOn(hi)!.lat, lng: stayOn(hi)!.lng } : anchor);
      const dropped = new Set<Res>();
      for (const r of resolved) {
        if (r.existingId || r.it.category === "stay" || r.it.category === "transport") continue;
        const txt = `${r.label} ${r.it.name_local ?? ""}`;
        const eat = r.it.category === "food" || r.it.category === "cafe";
        if (eat && noSpicy && stopRules.spicy(txt)) dropped.add(r);
        else if (eat && r.loc?.approx && stopRules.generic(r.label)) dropped.add(r);
        else if (days > 1 && r.it.day === days - 1 && onlyDay == null && hotelAt && r.pt && distKm(r.pt, hotelAt) > 25) dropped.add(r);
        // a block of a long trip: a stop the model put on a day outside the block
        else if (rg && !inScope(r.it.day, rg)) dropped.add(r);
      }
      // a pin far from both its day and the hotel, while the AI meant somewhere close, is a wrong match (a branch 50 km out of town)
      for (const d of new Set(resolved.map((r) => r.it.day))) {
        const day = resolved.filter((r) => r.it.day === d && r.it.category !== "stay" && r.it.category !== "transport" && r.pt && !dropped.has(r));
        if (day.length < 3) continue;
        const mid = median(day);
        for (const r of day) {
          if (r.existingId) continue;
          const g = guessOf(r);
          const offAi = g ? distKm(g, r.pt!) : null;            // map pin vs where the AI said it is
          const fromDay = distKm(r.pt!, mid), fromHotel = hotelAt ? distKm(r.pt!, hotelAt) : fromDay;
          // a same-named place elsewhere ("Bennelong Park" in Putney for Bennelong Point, a café 20 km out):
          // the pin is far from the AI's own spot AND far from the day → look again near the AI's spot, else drop
          const wrong = (offAi != null && offAi > 5 && fromDay > 6 && fromHotel > 6) || (offAi == null && fromDay > 20 && fromHotel > 20);
          if (!wrong) continue;
          const eatHere = r.it.category === "food" || r.it.category === "cafe";
          // a meal 45 km out while the rest of the day is in town is the wrong branch / the model's mistake, not a day trip
          if (eatHere && fromDay > 8 && fromHotel > 8) { dropped.add(r); continue; }
          if (g && distKm(g, mid) > 20) continue; // the AI planned a real day trip there
          const again = g && Date.now() - t0 < 230_000
            ? await resolvePlace(r.it.name_local ?? r.it.name, null, g, 3, { alt: r.it.name_local ? r.it.name : null, category: r.it.category, strict: true, nearest: true }).catch(() => null) : null;
          if (again && !again.approx && distKm(again, g!) <= 3) { r.loc = again; r.pt = { lat: again.lat, lng: again.lng }; continue; }
          dropped.add(r);
        }
      }
      // a theme park / zoo day: anything more than 2 km away that falls inside the visit is impossible
      const BIGPARK = /disney|universal|theme ?park|legoland|safari world|lotte world|everland|chimelong|zoo|aquarium|สวนสนุก|สวนสัตว์|อควาเรียม|sea ?life/i;
      for (const r of resolved) {
        if (dropped.has(r) || r.it.category === "stay" || !BIGPARK.test(`${r.label} ${r.it.name}`) || !r.pt) continue;
        if (/zoo|aquarium|sea ?life|สวนสัตว์|อควาเรียม/i.test(`${r.label} ${r.it.name}`)) r.it.duration_min = Math.min(r.it.duration_min ?? 240, /aquarium|sea ?life|อควาเรียม/i.test(`${r.label} ${r.it.name}`) ? 180 : 300);
        const st = r.it.start_time ? Number(r.it.start_time.slice(0, 2)) * 60 + Number(r.it.start_time.slice(3, 5)) : null;
        if (st == null) continue;
        const end = st + (r.it.duration_min ?? 240);
        for (const o of resolved) {
          if (o === r || o.it.day !== r.it.day || o.existingId || dropped.has(o) || o.it.category === "stay" || o.it.category === "transport" || !o.pt || !o.it.start_time) continue;
          const ot = Number(o.it.start_time.slice(0, 2)) * 60 + Number(o.it.start_time.slice(3, 5));
          if (ot > st && ot < end - 15 && distKm(o.pt, r.pt) > 2) dropped.add(o);
        }
      }
      // the same venue twice (a rooftop bar and then "dinner" at the same bar, or one restaurant for two meals): keep the first
      const seenVenue: { r: Res; key: string }[] = [];
      const otherKeys = new Set(others.map(norm).filter((k) => k.length >= 4));
      // the same restaurant chain twice in a trip (外婆家 three dinners in a week): keep the first, the meal check refills the rest
      const brandOf = (s: string) => norm(s.split(/[(（]/)[0]);
      const brands = new Set(others.map(brandOf).filter((k) => k.length >= 2));
      for (const r of resolved.filter((x) => x.it.category !== "stay" && x.it.category !== "transport" && !dropped.has(x)).sort((x, y) => x.it.day - y.it.day || x.it.order - y.it.order)) {
        const keys = [norm(r.label), norm(r.it.name), r.it.name_local ? norm(r.it.name_local) : ""].filter((k) => k.length >= 4);
        const same = (v: { r: Res }) => v.r.it.day === r.it.day;
        const eatsHere = r.it.category === "food" || r.it.category === "cafe";
        const dup = seenVenue.find((v) => keys.some((k) => k === v.key) ||
          (eatsHere && (v.r.it.category === "food" || v.r.it.category === "cafe") && v.r.pt && r.pt && distKm(v.r.pt, r.pt) < 0.03) ||
          // name containment only within the same kind: "Lingyin Temple Vegetarian Restaurant" is not "Lingyin Temple"
          (same(v) && eatsHere === (v.r.it.category === "food" || v.r.it.category === "cafe") && keys.some((k) => Math.min(k.length, v.key.length) >= 5 && (v.key.includes(k) || k.includes(v.key)))) ||
          (same(v) && eatsHere === (v.r.it.category === "food" || v.r.it.category === "cafe") && v.r.pt && r.pt && distKm(v.r.pt, r.pt) < 0.05));
        // …or a venue another day of the trip already has (long trips are planned in blocks)
        const brand = eatsHere ? brandOf(r.label) : "";
        if (!r.existingId && (dup || keys.some((k) => otherKeys.has(k)) || (brand.length >= 2 && brands.has(brand)))) { dropped.add(r); continue; }
        if (brand.length >= 2) brands.add(brand);
        for (const k of keys) seenVenue.push({ r, key: k });
      }
      // tasting menus / fine dining take ~3 hours and need a booking
      for (const r of resolved) {
        if ((r.it.category === "food") && /attica|degustation|tasting menu|omakase|โอมากาเสะ|fine dining|michelin|chef'?s table|kaiseki|懐石/i.test(`${r.label} ${r.it.why ?? ""}`)) {
          r.it.duration_min = Math.max(r.it.duration_min ?? 0, 150);
          if (!/จอง/.test(r.it.why ?? "")) r.it.why = `ต้องจองล่วงหน้า · ${r.it.why ?? ""}`.slice(0, 300);
        }
      }
      // final timetable from the real pins: travel time between stops, meals kept inside their windows
      for (const d of new Set(resolved.map((r) => r.it.day))) {
        const list = resolved.filter((r) => r.it.day === d && r.it.category !== "stay" && !dropped.has(r)).sort((x, y) => x.it.order - y.it.order);
        const out = settleDay(list.map((r) => ({ ref: r, start_time: r.it.start_time, duration_min: r.it.duration_min, category: r.it.category, name: r.label, lat: r.pt?.lat ?? null, lng: r.pt?.lng ?? null, fixed: !!(r.it as { fixed?: boolean }).fixed })),
          { endBy: d === days - 1 && days > 1 ? leaveBy : null, mode: prefs.mode, pinHub: !!prefs.depart_time, calib: trip.cur_prefs?.calib ?? null });
        // museums, temples and gardens close around 17:00: a visit that the timetable pushed into the evening is dropped
        const late = out.filter((o) => !o.ref.existingId && o.start_time && ((o.start_time >= "17:00" && !["food", "cafe", "shopping", "nightlife", "transport"].includes(o.category) && stopRules.daytimeOnly(o.name))
          || hourRule({ name: o.name, category: o.category, lat: o.lat, lng: o.lng }, Number(o.start_time.slice(0, 2)) * 60 + Number(o.start_time.slice(3, 5))) != null));
        const kept = new Set(out.filter((o) => !late.includes(o)).map((o) => o.ref));
        for (const r of list) if (!kept.has(r) && !r.existingId) dropped.add(r);
        out.filter((o) => kept.has(o.ref)).forEach((o, i) => { o.ref.it.start_time = o.start_time; o.ref.it.duration_min = o.duration_min; o.ref.it.order = i; });
      }
      const finalList = resolved.filter((r) => !dropped.has(r));

      let added = 0, moved = 0;
      // re-planning replaces the previous AI plan, but never touches what people added, voted for or ticked off
      const keep = finalList.map((r) => r.existingId).filter(Boolean) as string[];
      let removed = 0;
      await sql.begin(async (tx) => {
        const del = await tx`delete from pinpai.places p where p.trip_id = ${id} and p.source = 'ai' and coalesce(p.details->>'planned', '') = 'true'
          and (${lo}::int is null or (p.day_index between ${lo} and ${hi} and p.category <> 'stay'))
          and not p.visited and not (p.details ? 'user_edited') and not (p.id = any(${keep}::uuid[])) and not exists (select 1 from pinpai.votes v where v.place_id = p.id)`;
        removed = del.count;
        for (const r of finalList) {
          const sort = (r.it.order + 1) * 10;
          const details = { why: r.it.why, ...(r.it.nights ? { nights: r.it.nights } : {}), ...(r.loc?.approx ? { approx: true } : {}), ...(shifted.has(r) ? { geo_checked: true } : {}), planned: true };
          if (r.existingId) {
            const ex = exById.get(r.existingId);
            await tx`update pinpai.places set day_index = ${r.it.day}, sort_order = ${sort}, start_time = ${ex?.fixed ? ex.start_time : sql`coalesce(${r.it.start_time}, start_time)`},
              duration_min = coalesce(duration_min, ${r.it.duration_min}), updated_at = now() where id = ${r.existingId} and trip_id = ${id}`;
            moved++;
          } else {
            await tx`insert into pinpai.places (trip_id, name, category, lat, lng, address, day_index, sort_order, start_time, duration_min, details, source, added_by)
              values (${id}, ${r.label.slice(0, 160)}, ${r.it.category}, ${r.loc?.lat ?? null}, ${r.loc?.lng ?? null}, ${r.loc?.address ?? null},
                ${r.it.day}, ${sort}, ${r.it.start_time}, ${r.it.duration_min ? Math.round(r.it.duration_min) : null}, ${sql.json(details as never)}, 'ai', ${me.id})`;
            added++;
          }
        }
        if (lo != null) {
          const th = Object.fromEntries(plan.days.filter((d) => d.theme && inScope(d.day, sc)).map((d) => [d.day, d.theme]));
          if (Object.keys(th).length) await tx`update pinpai.trips set guide = jsonb_set(coalesce(guide, '{}'::jsonb), '{themes}', coalesce(guide->'themes', '{}'::jsonb) || ${sql.json(th as never)}) where id = ${id}`;
          return;
        }
        const guide = { summary: plan.summary, getting_there: plan.getting_there, getting_around: plan.getting_around, tips: plan.tips,
          prep: (plan.prep ?? []).map((t) => String(t).replace(/[:：]?\s*\+?\d[\d\s().-]{7,}\d/g, " (เช็กเบอร์ล่าสุดจากเว็บทางการ)").trim().slice(0, 200)).filter(Boolean).slice(0, 10),
          themes: Object.fromEntries(plan.days.map((d) => [d.day, d.theme])), generated_at: new Date().toISOString(),
          costs: plan.costs ? Object.fromEntries(Object.entries(plan.costs).map(([k, v]) => [k, typeof v === "number" ? Math.max(0, Math.round(v)) : v])) : undefined };
        await tx`update pinpai.trips set prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ ...prefs, ...money } as never)}, guide = ${sql.json(guide as never)} where id = ${id}`;
      });
      // stops people placed by hand that the AI didn't mention are still on their day: slot everything by time,
      // then let the timetable flow around them (locked times never move, nothing is pulled earlier)
      // the AI named the hotel before the days were placed: now that they are, move a hotel that sits far from them
      // (never one people chose); a one-day re-plan leaves the hotel alone
      const rehomed = onlyDay != null ? [] : await rehomeHotels(id, typeof sc === "number" ? [sc, sc] : sc, Math.min(t0 + 215_000, Date.now() + 35_000)).catch((e) => { console.error("rehome", e); return []; });
      if (rehomed.length) console.log("rehome", rehomed.map((r) => `${r.from} → ${r.to} (−${r.savedKm} km)`).join(" | "));
      const touchedDays = onlyDay != null ? [onlyDay] : [...new Set(finalList.map((r) => r.it.day))];
      for (const d of touchedDays) {
        if (rehomed.length) { await sql.begin((tx) => retimeStored(tx, id, d, { keepGaps: true })).catch(() => {}); }
        const extra = await sql`select 1 from pinpai.places where trip_id = ${id} and day_index = ${d} and category <> 'stay'
          and not (id = any(${keep}::uuid[])) and (source <> 'ai' or details ? 'user_edited') limit 1`;
        const locked = finalList.some((r) => r.it.day === d && (r.it as { fixed?: boolean }).fixed);
        if (!extra.length && !locked) continue;
        await sql.begin(async (tx) => {
          await tx`update pinpai.places p set sort_order = r.n * 10 from (
              select id, row_number() over (order by (category <> 'stay'), (start_time is null), start_time, sort_order) as n from pinpai.places where trip_id = ${id} and day_index = ${d}) r
            where p.id = r.id and p.trip_id = ${id}`;
          await retimeStored(tx, id, d, { keepGaps: true });
        }).catch((e) => console.error("retime after plan", d, e));
      }
      // running first: real scenic routes near the hotel instead of the AI's guessed "running spot" (tidy then knows where mornings start)
      await addRunRoutes(id, days, sc).catch((e) => console.error("run routes", e));
      // geography: a stop far from the rest of its day moves to a day around there, free sights are put in the
      // shortest order between meals / locked times, and days that still need a lot of driving are flagged for the app
      await tightenDays(id, days, sc, t0 + 235_000).then(async ({ notes, flags }) => {
        if (notes.length) console.log("tighten", notes.join(" | "));
        await sql`update pinpai.trips set guide = jsonb_set(coalesce(guide, '{}'::jsonb), '{flags}',
            coalesce((select jsonb_agg(f) from jsonb_array_elements(coalesce(guide->'flags', '[]'::jsonb)) f
              where not ((f->>'day')::int between ${typeof sc === "number" ? sc : sc ? sc[0] : 0} and ${typeof sc === "number" ? sc : sc ? sc[1] : 999})), '[]'::jsonb) || ${sql.json(flags as never)})
          where id = ${id}`;
      }).catch((e) => console.error("tighten", e));
      // nothing before landing / after take-off, closed-for-good places, double dinners, diet clashes
      await tidyDays(id, days, sc, t0 + 240_000).then((n) => n.length && console.log("tidy", n.join(" | "))).catch((e) => console.error("tidy", e));
      // real, known, still open? (Wikipedia / Wikidata) — closed-for-good sights leave the plan
      await verifyTripPlaces(id, Math.min(t0 + 225_000, Date.now() + 45_000)).then((v) => v.closed.length && console.log("closed", v.closed.join(" | "))).catch((e) => console.error("verify", e));
      // bags: drop at the hotel after landing, check-out + pick-up on the last day, moving between hotels
      await addHotelTasks(id, days, sc).catch((e) => console.error("hotel tasks", e));
      // activities the group asked for that are still missing → a real venue from the map
      await ensureWants(id, days, sc, t0 + 255_000).then((n) => n.length && console.log("wants", n.join(" | "))).catch((e) => console.error("wants", e));
      // meals the AI left empty → a real restaurant next to the stop before (OpenStreetMap), within the time budget
      await fillMissingMeals(id, days, sc, t0 + 275_000).catch((e) => console.error("meal fill", e));
      return { added, moved, days, removed };
    }
  });
}

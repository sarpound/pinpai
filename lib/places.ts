import { sql } from "./db";
import { CATEGORIES } from "./ai";
import { num, str } from "./auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** keep a day's order as clean 10, 20, 30… after an in-between insert */
export async function renumberDay(tripId: string, day: number | null) {
  await sql`update pinpai.places p set sort_order = r.n * 10 from (
      select id, row_number() over (order by sort_order, created_at) as n from pinpai.places
      where trip_id = ${tripId} and day_index is not distinct from ${day}) r
    where p.id = r.id and p.trip_id = ${tripId}`;
}

export function cleanCategory(c: unknown) {
  return (CATEGORIES as readonly string[]).includes(c as string) ? (c as string) : "attraction";
}

export async function insertPlace(tripId: string, memberId: string, p: Record<string, unknown>) {
  const name = str(p.name, 160);
  if (!name) return null;
  const day = num(p.day_index);
  let dayIndex = day != null && day >= 0 && day <= 60 ? Math.floor(day) : null;
  if (dayIndex != null) {   // a day past the trip's last day would be invisible: keep it in "รอจัด" instead
    const [t] = await sql`select (end_date - start_date + 1)::int as n from pinpai.trips where id = ${tripId}`;
    if (t?.n != null && dayIndex >= t.n) dayIndex = null;
  }
  // insert right after another stop (gap filler, "near here", clip → nearest day)
  const afterId = typeof p.after_id === "string" && UUID.test(p.after_id) ? p.after_id : null;
  const [after] = afterId ? await sql`select day_index, sort_order from pinpai.places where id = ${afterId} and trip_id = ${tripId}` : [];
  if (after && !Object.prototype.hasOwnProperty.call(p, "day_index")) dayIndex = after.day_index;
  const want = num(p.sort_order);
  const [{ next }] = after && after.day_index === dayIndex ? [{ next: Number(after.sort_order) + 5 }]
    : want != null && Math.abs(want) < 1e6 ? [{ next: Math.round(want) }]
    : await sql`select coalesce(max(sort_order), 0) + 10 as next from pinpai.places
    where trip_id = ${tripId} and day_index is not distinct from ${dayIndex}`;
  const startTime = typeof p.start_time === "string" && TIME.test(p.start_time) ? p.start_time : null;
  const dur = num(p.duration_min);
  const duration = dur != null && dur >= 5 && dur <= 720 ? Math.round(dur) : null;
  const lat = num(p.lat), lng = num(p.lng);
  const okCoord = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const src = ["manual", "video", "ai", "search"].includes(p.source as string) ? (p.source as string) : "manual";
  // clients only send { why }; don't let them store arbitrary/huge jsonb or spoof AI fields (summary, ai…)
  const why = typeof p.details === "object" && p.details ? str((p.details as Record<string, unknown>).why, 300) : null;
  const ph = typeof p.details === "object" && p.details ? (p.details as Record<string, unknown>).photo as Record<string, string> | undefined : undefined;
  const photo = ph && typeof ph.url === "string" && ph.url.startsWith("https://upload.wikimedia.org/") && typeof ph.page === "string" && /^https:\/\/[a-z]+\.wikipedia\.org\//.test(ph.page)
    ? { url: ph.url.slice(0, 500), page: ph.page.slice(0, 300), title: String(ph.title ?? "").slice(0, 160) } : null;
  const details = { ...(why ? { why } : {}), ...(photo ? { photo, photo_checked: true } : {}) };
  // only a real web link can be stored (a "javascript:" link would run in a friend's browser when they tap it)
  const srcRaw = str(p.source_url, 500);
  const srcUrl = srcRaw && /^https?:\/\/[^\s]+$/i.test(srcRaw) ? srcRaw : null;
  const [row] = await sql`insert into pinpai.places
    (trip_id, name, category, lat, lng, address, day_index, sort_order, start_time, duration_min, notes, details, source, source_url, added_by)
    values (${tripId}, ${name}, ${cleanCategory(p.category)}, ${okCoord ? lat : null}, ${okCoord ? lng : null},
      ${str(p.address, 300)}, ${dayIndex}, ${next}, ${startTime}, ${duration}, ${str(p.notes, 1000)}, ${sql.json(details as never)}, ${src},
      ${srcUrl && /^https?:\/\//.test(srcUrl) ? srcUrl : null}, ${memberId})
    returning id`;
  if ((after && after.day_index === dayIndex) || want != null) await renumberDay(tripId, dayIndex);
  return row.id as string;
}

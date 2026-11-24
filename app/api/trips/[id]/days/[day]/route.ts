import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, num, HttpError } from "@/lib/auth";
import { loadDay, stampOf, retimeStored } from "@/lib/dayplan";
import { movedIds } from "@/lib/retime";
import type { Warning } from "@/lib/retime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
type Edit = { start_time?: string | null; duration_min?: number | null; fixed?: boolean; user_dur?: boolean };

/**
 * Save a whole day in one go: new order (may pull stops in from other days), time/duration/lock edits,
 * then recompute the timetable. Refuses with 409 if someone else changed this day since `stamp`.
 * body: { stamp, order: uuid[], edits?: { [id]: Edit }, retime?: boolean }
 */
export async function PUT(req: Request, ctx: RouteContext<"/api/trips/[id]/days/[day]">) {
  return handle(async () => {
    const { id, day: dayStr } = await ctx.params;
    const me = await requireMember(req, id);
    const day = Number(dayStr);
    if (!Number.isInteger(day) || day < 0 || day > 60) throw new HttpError(400, "วันไม่ถูกต้อง");
    const [span] = await sql`select (end_date - start_date + 1)::int as n from pinpai.trips where id = ${id}`;
    if (span?.n != null && day >= span.n) throw new HttpError(400, "วันนี้อยู่นอกช่วงทริป");
    const b = await readJson<{ stamp?: string; order?: unknown; edits?: Record<string, Edit>; retime?: boolean; restore?: boolean;
      drop?: unknown; times?: Record<string, { start_time?: string | null; duration_min?: number | null }> }>(req);
    // stops taken out of the day → back to the wishlist ("รอจัด")
    const drop = Array.isArray(b.drop) ? b.drop.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 40) : [];
    // the timetable exactly as the editor previewed it (same engine) → saved as-is, not re-timed
    const times = b.times && typeof b.times === "object" ? b.times : null;
    const order = Array.isArray(b.order) ? b.order.filter((x): x is string => typeof x === "string" && UUID.test(x)) : null;
    if (!order || new Set(order).size !== order.length || order.length > 80) throw new HttpError(400, "ลำดับไม่ถูกต้อง");
    const edits = b.edits && typeof b.edits === "object" ? b.edits : {};

    let warnings: Warning[] = [];
    let conflict: { stamp: string } | null = null;
    const pulled: { id: string; from: number | null; name: string }[] = [];
    let moved: string[] = [];
    await sql.begin(async (tx) => {
      const rows = await loadDay(tx, id, day, true);
      const stamp = stampOf(rows);
      if (b.stamp && b.stamp !== stamp) { conflict = { stamp }; return; }
      const here = new Set(rows.map((r) => r.id));
      // every stop of the day must still be in the list (deleting goes through DELETE, not by omission)
      if (rows.some((r) => !order.includes(r.id) && !drop.includes(r.id))) throw new HttpError(400, "รายการของวันนี้ไม่ครบ ลองโหลดใหม่");
      if (drop.some((x) => !here.has(x) || order.includes(x))) throw new HttpError(400, "รายการที่เอาออกไม่ถูกต้อง");
      for (const x of drop) {
        await tx`update pinpai.places set day_index = null, start_time = null, sort_order = (select coalesce(max(sort_order), 0) + 10 from pinpai.places where trip_id = ${id} and day_index is null),
          details = coalesce(details, '{}'::jsonb) || ${sql.json({ fixed_time: false, user_edited: new Date().toISOString() } as never)}, updated_at = now()
          where id = ${x} and trip_id = ${id}`;
      }
      const incoming = order.filter((x) => !here.has(x));
      if (incoming.length) {
        const ext = await tx`select id, day_index, name from pinpai.places where trip_id = ${id} and id = any(${incoming}::uuid[]) for update`;
        if (ext.length !== incoming.length) throw new HttpError(400, "มีสถานที่ที่ไม่อยู่ในทริปนี้");
        for (const e of ext) pulled.push({ id: e.id, from: e.day_index, name: e.name });
      }
      moved = [...movedIds(rows.map((r) => r.id), order.filter((x) => here.has(x))), ...incoming];
      // undo restores the previous state as it was: it does not count as a new hand edit
      const touched = new Set(b.restore ? [] : [...moved, ...Object.keys(edits).filter((k) => UUID.test(k))]);

      for (const [i, pid] of order.entries()) {
        const e = edits[pid] ?? {};
        const has = (k: keyof Edit) => Object.prototype.hasOwnProperty.call(e, k);
        const cur = rows.find((r) => r.id === pid);
        // a stop pulled in from another day loses its old time (it was for a different day)
        let st: string | null = cur ? cur.start_time : null;
        if (has("start_time")) st = typeof e.start_time === "string" && TIME.test(e.start_time) ? e.start_time : null;
        const d = has("duration_min") ? num(e.duration_min) : null;
        const patch: Record<string, unknown> = {};
        if (touched.has(pid)) patch.user_edited = new Date().toISOString();
        if (has("fixed")) patch.fixed_time = !!e.fixed && st != null;
        else if (!cur || st == null) patch.fixed_time = false;
        if (has("duration_min")) patch.user_dur = d != null;
        if (has("user_dur")) patch.user_dur = !!e.user_dur;
        await tx`update pinpai.places set day_index = ${day}, sort_order = ${(i + 1) * 10}, start_time = ${st},
          duration_min = ${has("duration_min") ? (d != null ? Math.max(5, Math.min(1440, Math.round(d))) : null) : (cur ? cur.duration_min : sql`duration_min`)},
          details = coalesce(details, '{}'::jsonb) || ${sql.json(patch as never)}, updated_at = now()
          where id = ${pid} and trip_id = ${id}`;
      }
      // close the holes left in the days the pulled stops came from
      for (const from of new Set(pulled.map((p) => p.from).filter((x): x is number => x != null && x !== day)))
        await tx`update pinpai.places p set sort_order = r.n * 10 from (
            select id, row_number() over (order by sort_order, created_at) as n from pinpai.places where trip_id = ${id} and day_index = ${from}) r
          where p.id = r.id and p.trip_id = ${id}`;
      if (times) {
        for (const pid of order) {
          const t = times[pid];
          if (!t) continue;
          const st = typeof t.start_time === "string" && TIME.test(t.start_time) ? t.start_time : null;
          const d = num(t.duration_min);
          await tx`update pinpai.places set start_time = ${st}, duration_min = ${d != null ? Math.max(5, Math.min(1440, Math.round(d))) : sql`duration_min`}
            where id = ${pid} and trip_id = ${id}`;
        }
      } else if (b.retime !== false) warnings = (await retimeStored(tx, id, day)).warnings;
    });
    if (conflict) {
      const rows = await loadDay(sql, id, day);
      return NextResponse.json({ error: "มีเพื่อนเพิ่งแก้วันนี้ โหลดของล่าสุดแล้วลองอีกครั้ง", stamp: (conflict as { stamp: string }).stamp, rows }, { status: 409 });
    }
    const rows = await loadDay(sql, id, day);
    const movedNames = rows.filter((r) => moved.includes(r.id)).map((r) => r.name);
    if (drop.length) await logActivity(id, me.id, `${me.name} เอา ${drop.length} ที่ออกจากวันที่ ${day + 1} ไปไว้รอจัด`);
    if (pulled.length) await logActivity(id, me.id, `${me.name} ย้าย ${pulled.map((p) => p.name).join(", ")} มาวันที่ ${day + 1}`);
    else if (movedNames.length || Object.keys(edits).length) await logActivity(id, me.id, `${me.name} ปรับแผนวันที่ ${day + 1}`);
    await bumpVersion(id);
    return NextResponse.json({ ok: true, stamp: stampOf(rows), warnings, moved });
  });
}

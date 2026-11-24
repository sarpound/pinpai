import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, str, num, assertUuid, HttpError } from "@/lib/auth";
import { cleanCategory } from "@/lib/places";
import { loadDay, dayCtx, toRStop, retimeStored } from "@/lib/dayplan";
import { bestSlots } from "@/lib/retime";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function PATCH(req: Request, ctx: RouteContext<"/api/trips/[id]/places/[pid]">) {
  return handle(async () => {
    const { id, pid } = await ctx.params;
    const me = await requireMember(req, id);
    assertUuid(pid);
    const [cur] = await sql`select * from pinpai.places where id = ${pid} and trip_id = ${id}`;
    if (!cur) throw new HttpError(404, "ไม่พบสถานที่");
    const b = await readJson(req);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);

    let day = cur.day_index as number | null;
    if (has("day_index")) {
      const d = num(b.day_index);
      day = d != null && d >= 0 && d <= 60 ? Math.floor(d) : null;
    }
    let sort = cur.sort_order as number;
    let order: string[] | null = null;
    let placed: { day: number; after: string | null; at: string | null } | null = null;
    if (has("sort_order") && num(b.sort_order) != null) {
      // client sends a fractional midpoint; renumber the whole day to clean integers (10, 20, …)
      // so repeated moves never produce non-integers or ties
      const want = num(b.sort_order)!;
      const sibs = await sql`select id, sort_order from pinpai.places where trip_id = ${id} and day_index is not distinct from ${day} and id <> ${pid} order by sort_order, created_at`;
      order = sibs.map((s) => s.id as string);
      const at = sibs.findIndex((s) => Number(s.sort_order) > want);
      order.splice(at < 0 ? order.length : at, 0, pid);
      sort = (order.indexOf(pid) + 1) * 10;
    } else if (day !== cur.day_index && day != null && cur.category !== "stay" && !has("start_time")) {
      // moved to another day: put it where it adds the least travel and fits the day's times
      const rows = await loadDay(sql, id, day);
      const ctxDay = await dayCtx(sql, id, day);
      const [best] = bestSlots(rows.map(toRStop), { name: cur.name, category: cur.category, lat: cur.lat == null ? null : Number(cur.lat), lng: cur.lng == null ? null : Number(cur.lng), duration_min: cur.duration_min }, ctxDay, 1);
      const stops = rows.filter((r) => r.category !== "stay");
      order = rows.map((r) => r.id);
      const at = best ? (best.after_id ? order.indexOf(best.after_id) + 1 : Math.max(0, order.indexOf(stops[0]?.id ?? ""))) : order.length;
      order.splice(at < 0 ? order.length : at, 0, pid);
      sort = (order.indexOf(pid) + 1) * 10;
      placed = { day, after: best?.after_name ?? null, at: best?.start_time ?? null };
    } else if (day !== cur.day_index) {
      const [{ next }] = await sql`select coalesce(max(sort_order), 0) + 10 as next from pinpai.places where trip_id = ${id} and day_index is not distinct from ${day}`;
      sort = next;
    }
    const lat = has("lat") ? num(b.lat) : cur.lat;
    const lng = has("lng") ? num(b.lng) : cur.lng;
    if ((lat == null) !== (lng == null) || (lat != null && (Math.abs(lat) > 90 || Math.abs(lng!) > 180))) throw new HttpError(400, "พิกัดไม่ถูกต้อง");
    const dayMoved = day !== cur.day_index;
    // a time belongs to its day: moving to another day without a new time drops the old one
    const startTime = has("start_time") ? (typeof b.start_time === "string" && TIME.test(b.start_time) ? b.start_time : null) : dayMoved ? null : cur.start_time;
    const dur = has("duration_min") ? num(b.duration_min) : cur.duration_min;
    // a person touched the timing/placement → the AI must keep it when re-planning
    const userTouched = dayMoved || order != null || (has("start_time") && startTime !== cur.start_time) || (has("duration_min") && dur !== cur.duration_min);
    const detPatch: Record<string, unknown> = userTouched ? { user_edited: new Date().toISOString() } : {};
    if (startTime == null || dayMoved) detPatch.fixed_time = false;
    if (has("fixed")) detPatch.fixed_time = !!b.fixed && startTime != null;

    await sql.begin(async (tx) => {
    await tx`update pinpai.places set
      name = ${has("name") ? str(b.name, 160) ?? cur.name : cur.name},
      category = ${has("category") ? cleanCategory(b.category) : cur.category},
      lat = ${lat}, lng = ${lng},
      address = ${has("address") ? str(b.address, 300) : cur.address},
      day_index = ${day}, sort_order = ${sort}, start_time = ${startTime},
      duration_min = ${dur != null ? Math.max(0, Math.min(1440, Math.round(dur))) : null},
      notes = ${has("notes") ? str(b.notes, 1000) : cur.notes},
      visited = ${has("visited") ? Boolean(b.visited) : cur.visited},
      details = coalesce(details, '{}'::jsonb) || ${sql.json(detPatch as never)},
      updated_at = now()
      where id = ${pid} and trip_id = ${id}`;
    if (order) for (const [i, oid] of order.entries()) if (oid !== pid) await tx`update pinpai.places set sort_order = ${(i + 1) * 10} where id = ${oid} and trip_id = ${id}`;
    if (placed) await retimeStored(tx, id, placed.day, { keepGaps: true });
    });
    if (dayMoved) await logActivity(id, me.id, `${me.name} ย้าย ${cur.name} ไป${day == null ? "รายการรอจัด" : `วันที่ ${day + 1}`}`);
    await bumpVersion(id);
    if (placed) {
      const [r] = await sql`select start_time from pinpai.places where id = ${pid}`;
      placed.at = r?.start_time ?? placed.at;
    }
    return NextResponse.json({ ok: true, placed });
  });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/trips/[id]/places/[pid]">) {
  return handle(async () => {
    const { id, pid } = await ctx.params;
    const me = await requireMember(req, id);
    assertUuid(pid);
    const [row] = await sql`delete from pinpai.places where id = ${pid} and trip_id = ${id} returning name`;
    if (row) await logActivity(id, me.id, `${me.name} ลบ ${row.name}`);
    await bumpVersion(id);
    return NextResponse.json({ ok: true });
  });
}

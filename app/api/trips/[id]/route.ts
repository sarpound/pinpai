import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, str, num, HttpError, newInviteCode } from "@/lib/auth";
import { loadTripState } from "@/lib/state";
import { geocodeDestination } from "@/lib/geo";

export const dynamic = "force-dynamic";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// locations and pings change often without bumping the trip version
async function liveStamp(id: string) {
  const [r] = await sql`select (select max(updated_at) from pinpai.locations where trip_id = ${id}) as at,
    (select max(id) from pinpai.pings where trip_id = ${id}) as ping,
    (select max(id) from pinpai.messages where trip_id = ${id}) as msg`;
  return `${r?.at ? new Date(r.at).getTime() : 0}:${r?.ping ?? 0}:${r?.msg ?? 0}`;
}

export async function GET(req: Request, ctx: RouteContext<"/api/trips/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    // cheap poll: client sends its known version; skip the heavy payload when nothing changed
    const known = new URL(req.url).searchParams.get("v");
    if (known) {
      const [t] = await sql`select version from pinpai.trips where id = ${id}`;
      const stamp = `${t.version}:${await liveStamp(id)}`;
      if (stamp === known) return NextResponse.json({ unchanged: true });
      const state = await loadTripState(id, me.id);
      return NextResponse.json({ ...state, stamp });
    }
    const state = await loadTripState(id, me.id);
    return NextResponse.json({ ...state, stamp: `${state.trip.version}:${await liveStamp(id)}` });
  });
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/trips/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    // dates as text: `postgres` parses date columns into JS Dates, which would be written back as timestamptz
    const [cur] = await sql`select title, destination, dest_lat, dest_lng, start_date::text, end_date::text, cover_emoji, prefs from pinpai.trips where id = ${id}`;
    const title = str(b.title, 120) ?? cur.title;
    const destination = b.destination === undefined ? cur.destination : str(b.destination, 120);
    const start = b.start_date === undefined ? cur.start_date : typeof b.start_date === "string" && DATE.test(b.start_date) ? b.start_date : null;
    const end = b.end_date === undefined ? cur.end_date : typeof b.end_date === "string" && DATE.test(b.end_date) ? b.end_date : null;
    if (start && end && end < start) throw new HttpError(400, "วันกลับต้องไม่ก่อนวันไป");
    if (start && end && (Date.parse(end) - Date.parse(start)) / 864e5 > 30) throw new HttpError(400, "ทริปยาวได้สูงสุด 31 วัน");
    const datesChanged = start !== cur.start_date || end !== cur.end_date;
    if (datesChanged) {
      // the planner writes by day number: changing dates under a running plan would scatter it
      const [busy] = await sql`select 1 from pinpai.trips where id = ${id} and plan_job->>'state' = 'running' and (plan_job->>'started_at')::timestamptz > now() - interval '6 minutes'`;
      if (busy) throw new HttpError(409, "กำลังจัดทริปอยู่ รอให้เสร็จก่อนแล้วค่อยเปลี่ยนวัน");
    }
    let lat = cur.dest_lat, lng = cur.dest_lng;
    if (destination && destination !== cur.destination) {
      const hit = await geocodeDestination(destination);
      if (hit) { lat = hit.lat; lng = hit.lng; }
    }
    let prefs = cur.prefs ?? {};
    if (b.prefs && typeof b.prefs === "object") {
      const m = (b.prefs as Record<string, unknown>).mode;
      if (typeof m === "string" && ["transit", "taxi", "drive", "walk"].includes(m)) prefs = { ...prefs, mode: m };
      const p = b.prefs as Record<string, unknown>;
      if ("budget_amount" in p) {
        const a = num(p.budget_amount);
        prefs = { ...prefs, budget_amount: a && a > 0 ? Math.min(1e8, Math.round(a)) : null };
      }
      if (p.budget_per === "person" || p.budget_per === "group") prefs = { ...prefs, budget_per: p.budget_per };
      if ("rally" in p) {
        const r = p.rally as Record<string, unknown> | null;
        const rl = r ? num(r.lat) : null, rg = r ? num(r.lng) : null;
        prefs = { ...prefs, rally: r && rl != null && rg != null && Math.abs(rl) <= 90 && Math.abs(rg) <= 180
          ? { lat: rl, lng: rg, name: str(r.name, 80) ?? "จุดนัดเจอ", by: me.name, at: new Date().toISOString() } : null };
        if (r) await logActivity(id, me.id, `${me.name} ปักธงจุดนัดเจอ 🚩`);
      }
    }
    await sql`update pinpai.trips set prefs = ${sql.json(prefs as never)}, title = ${title}, destination = ${destination}, dest_lat = ${lat}, dest_lng = ${lng},
      start_date = ${start}, end_date = ${end}, cover_emoji = ${str(b.emoji, 8) ?? cur.cover_emoji} where id = ${id}`;
    // a shorter trip: stops on days that no longer exist go back to "รอจัด" instead of vanishing
    if (datesChanged) {
      const span = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1 : 0;
      await sql`update pinpai.places set day_index = null, start_time = null
        where trip_id = ${id} and day_index is not null and day_index >= ${span}`;
    }
    // owner: a new invite link (the old one stops working — for a link that got shared too widely)
    if (b.rotate_invite === true) {
      if (me.role !== "owner") throw new HttpError(403, "เฉพาะเจ้าของทริปเท่านั้นที่เปลี่ยนลิงก์เชิญได้");
      await sql`update pinpai.trips set invite_code = ${newInviteCode()} where id = ${id}`;
      await logActivity(id, me.id, `${me.name} เปลี่ยนลิงก์เชิญใหม่`);
      await bumpVersion(id);
      return NextResponse.json({ ok: true });
    }
    await logActivity(id, me.id, `${me.name} แก้ไขข้อมูลทริป`);
    await bumpVersion(id);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/trips/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    if (me.role !== "owner") throw new HttpError(403, "เฉพาะเจ้าของทริปเท่านั้นที่ลบทริปได้");
    await sql`delete from pinpai.trips where id = ${id}`;
    return NextResponse.json({ ok: true });
  });
}

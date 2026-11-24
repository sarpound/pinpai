import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, num, HttpError } from "@/lib/auth";
import { detectMode, isMode, km, bearing, MODES } from "@/lib/presence";

// POST {lat,lng,accuracy,speed?,heading?, hours?, mode?} → share/update my location (auto-expires) + travel status.
// mode: a Mode to pin it manually for 3h, or "auto" to go back to detection. DELETE → stop sharing.
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/location">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    const lat = num(b.lat), lng = num(b.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, "พิกัดไม่ถูกต้อง");
    const hours = Math.min(24, Math.max(1, num(b.hours) ?? 0));
    const [m] = await sql`select share_location, share_until from pinpai.members where id = ${me.id}`;
    const active = m.share_location && (!m.share_until || new Date(m.share_until) > new Date());
    if (!active) {
      if (!num(b.hours)) throw new HttpError(409, "การแชร์ตำแหน่งหมดเวลาแล้ว เปิดใหม่อีกครั้ง");
      await sql`update pinpai.members set share_location = true, share_until = now() + make_interval(hours => ${hours}) where id = ${me.id}`;
      await logActivity(id, me.id, `${me.name} เริ่มแชร์ตำแหน่ง`);
      await bumpVersion(id);
    }
    const [prev] = (await sql`select lat, lng, updated_at, mode, mode_manual_at, trail from pinpai.locations where member_id = ${me.id}`) as unknown as ({ lat: number; lng: number; updated_at: string; mode: string | null; mode_manual_at: Date | null; trail: unknown } | undefined)[];
    const here = { lat, lng };
    let speed = num(b.speed); // m/s from the phone's GPS when it has one
    const gapMin = prev ? (Date.now() - new Date(prev.updated_at).getTime()) / 60000 : 0;
    const jump = prev ? km(prev, here) : 0;
    if ((speed == null || speed < 0) && prev && gapMin > 0.15 && gapMin < 30) speed = (jump * 1000) / (gapMin * 60);
    const kmh = speed != null && speed >= 0 ? speed * 3.6 : null;
    const heading = num(b.heading) ?? (prev && jump > 0.03 ? bearing(prev, here) : null);

    let mode: string | null = prev?.mode ?? null;
    let manualAt: Date | null = prev?.mode_manual_at ?? null;
    if (b.mode === "auto") manualAt = null;
    else if (isMode(b.mode)) { mode = b.mode; manualAt = new Date(); }
    const manualLive = manualAt && Date.now() - new Date(manualAt).getTime() < 3 * 3600_000;
    if (!manualLive) {
      manualAt = null;
      const [t] = await sql`select prefs from pinpai.trips where id = ${id}`;
      const pts = await sql`select lat::float8 as lat, lng::float8 as lng, category from pinpai.places where trip_id = ${id} and lat is not null`;
      const rally = t?.prefs?.rally && typeof t.prefs.rally.lat === "number" ? t.prefs.rally : null;
      mode = detectMode({ kmh, jumpKm: jump, gapMin, here, rally, travelPref: t?.prefs?.mode,
        stays: pts.filter((p) => p.category === "stay") as never, stops: pts.filter((p) => p.category !== "stay") as never });
    }
    // breadcrumb trail for the map (last ~20 moves, ≥40 m apart)
    let trail: { lat: number; lng: number; t: number }[] = Array.isArray(prev?.trail) ? prev.trail : [];
    const last = trail[trail.length - 1];
    if (!last || km(last, here) > 0.04) trail = [...trail, { lat: +lat.toFixed(5), lng: +lng.toFixed(5), t: Date.now() }].slice(-20);
    if (gapMin > 360) trail = [{ lat, lng, t: Date.now() }]; // new session: don't draw a line across the world

    await sql`insert into pinpai.locations (member_id, trip_id, lat, lng, accuracy, updated_at, speed, heading, mode, mode_manual_at, trail)
      values (${me.id}, ${id}, ${lat}, ${lng}, ${num(b.accuracy)}, now(), ${kmh}, ${heading}, ${mode}, ${manualAt}, ${sql.json(trail as never)})
      on conflict (member_id) do update set lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = now(),
        speed = excluded.speed, heading = excluded.heading, mode = excluded.mode, mode_manual_at = excluded.mode_manual_at, trail = excluded.trail`;
    // arrivals are news for the group
    if (mode !== prev?.mode && (mode === "hotel" || mode === "rally")) {
      await logActivity(id, me.id, `${me.name} ${MODES[mode as "hotel"].label} ${MODES[mode as "hotel"].emoji}`);
      await bumpVersion(id);
    }
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/trips/[id]/location">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    await sql`update pinpai.members set share_location = false, share_until = null where id = ${me.id}`;
    await sql`delete from pinpai.locations where member_id = ${me.id}`;
    await logActivity(id, me.id, `${me.name} หยุดแชร์ตำแหน่ง`);
    await bumpVersion(id);
    return NextResponse.json({ ok: true });
  });
}

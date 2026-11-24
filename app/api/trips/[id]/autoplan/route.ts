import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, HttpError } from "@/lib/auth";
import { autoPlan } from "@/lib/plan";

export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/autoplan">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const [trip] = await sql`select start_date::text, end_date::text from pinpai.trips where id = ${id}`;
    if (!trip.start_date || !trip.end_date) throw new HttpError(400, "ตั้งวันไปและวันกลับก่อน");
    // capped: k-means seeding is O(days² × places); the UI shows at most 31 days
    const days = Math.min(31, Math.round((Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 864e5) + 1);
    const places = await sql`select id, lat::float8 as lat, lng::float8 as lng, day_index, category, duration_min from pinpai.places where trip_id = ${id}`;
    const moves = autoPlan(places as never, days);
    if (!moves.length) throw new HttpError(400, "ไม่มีสถานที่ที่ยังไม่ได้จัดวัน (หรือยังไม่มีพิกัด)");
    await sql.begin(async (tx) => {
      for (const m of moves) await tx`update pinpai.places set day_index = ${m.day_index}, sort_order = ${m.sort_order} where id = ${m.id} and trip_id = ${id}`;
    });
    await logActivity(id, me.id, `${me.name} ให้ระบบจัดแผน ${days} วันอัตโนมัติ`);
    await bumpVersion(id);
    return NextResponse.json({ moved: moves.length });
  });
}

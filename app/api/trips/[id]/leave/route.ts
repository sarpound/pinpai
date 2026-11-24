import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, HttpError } from "@/lib/auth";

// POST → leave the trip (members only; the owner deletes the trip instead)
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/leave">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    if (me.role === "owner") throw new HttpError(400, "เจ้าของทริปออกไม่ได้ ใช้ลบทริปแทน");
    // leaving would orphan shared bills (payer gone, split still counting them): settle those first
    const [owed] = await sql`select 1 from pinpai.expenses where trip_id = ${id} and (paid_by = ${me.id} or ${me.id}::uuid = any(split)) limit 1`;
    if (owed) throw new HttpError(409, "ยังมีค่าใช้จ่ายที่หารกับคุณอยู่ เคลียร์หรือลบรายการเหล่านั้นก่อนออกจากทริป");
    await logActivity(id, null, `${me.name} ออกจากทริป`);
    await sql`delete from pinpai.members where id = ${me.id} and trip_id = ${id}`;
    await bumpVersion(id);
    return NextResponse.json({ ok: true });
  });
}

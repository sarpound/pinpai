import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, assertUuid, HttpError } from "@/lib/auth";

// DELETE ?mid= → the owner removes someone from the trip (an invite link that leaked, a friend who isn't coming).
// Their link stops working at once, and they stop seeing everyone's live location.
export async function DELETE(req: Request, ctx: RouteContext<"/api/trips/[id]/members">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    if (me.role !== "owner") throw new HttpError(403, "เฉพาะเจ้าของทริปเท่านั้นที่เอาคนออกได้");
    const mid = new URL(req.url).searchParams.get("mid") ?? "";
    assertUuid(mid);
    if (mid === me.id) throw new HttpError(400, "เจ้าของทริปเอาตัวเองออกไม่ได้");
    const [m] = await sql`select name from pinpai.members where id = ${mid} and trip_id = ${id}`;
    if (!m) throw new HttpError(404, "ไม่พบคนนี้ในทริป");
    const [owed] = await sql`select 1 from pinpai.expenses where trip_id = ${id} and (paid_by = ${mid}::uuid or ${mid}::uuid = any(split)) limit 1`;
    if (owed) throw new HttpError(409, `${m.name} ยังมีค่าใช้จ่ายที่หารกันอยู่ ลบหรือแก้รายการเหล่านั้นก่อน`);
    await sql`delete from pinpai.members where id = ${mid} and trip_id = ${id}`;
    await logActivity(id, me.id, `${me.name} เอา ${m.name} ออกจากทริป`);
    await bumpVersion(id);
    return NextResponse.json({ ok: true });
  });
}

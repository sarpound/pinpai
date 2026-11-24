import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, HttpError } from "@/lib/auth";

// POST → leave the trip (members only; the owner deletes the trip instead)
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/leave">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    if (me.role === "owner") throw new HttpError(400, "เจ้าของทริปออกไม่ได้ ใช้ลบทริปแทน");
    await logActivity(id, null, `${me.name} ออกจากทริป`);
    await sql`delete from pinpai.members where id = ${me.id} and trip_id = ${id}`;
    await bumpVersion(id);
    return NextResponse.json({ ok: true });
  });
}

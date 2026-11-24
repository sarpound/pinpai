import { NextResponse } from "next/server";
import { sql, bumpVersion } from "@/lib/db";
import { handle, requireMember, assertUuid, HttpError } from "@/lib/auth";

export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/places/[pid]/vote">) {
  return handle(async () => {
    const { id, pid } = await ctx.params;
    const me = await requireMember(req, id);
    assertUuid(pid);
    const [p] = await sql`select 1 from pinpai.places where id = ${pid} and trip_id = ${id}`;
    if (!p) throw new HttpError(404, "ไม่พบสถานที่");
    const del = await sql`delete from pinpai.votes where place_id = ${pid} and member_id = ${me.id} returning 1`;
    if (!del.length) await sql`insert into pinpai.votes (place_id, member_id) values (${pid}, ${me.id}) on conflict do nothing`;
    await bumpVersion(id);
    return NextResponse.json({ voted: !del.length });
  });
}

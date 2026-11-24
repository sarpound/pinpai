import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, HttpError } from "@/lib/auth";
import { insertPlace } from "@/lib/places";
import { retimeStored } from "@/lib/dayplan";

export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/places">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const [{ n }] = await sql`select count(*)::int as n from pinpai.places where trip_id = ${id}`;
    if (n >= 300) throw new HttpError(400, "ทริปนี้มีสถานที่ครบ 300 แห่งแล้ว");
    const b = await readJson(req);
    const pid = await insertPlace(id, me.id, b);
    if (!pid) throw new HttpError(400, "ใส่ชื่อสถานที่");
    // placed into a day at a chosen spot: give it a time and push later stops only as far as needed
    let warnings: unknown[] = [];
    if (b.retime === true) {
      const [row] = await sql`select day_index from pinpai.places where id = ${pid}`;
      if (row?.day_index != null) {
        await sql`update pinpai.places set details = details || ${sql.json({ user_edited: new Date().toISOString() } as never)} where id = ${pid}`;
        warnings = (await retimeStored(sql, id, row.day_index, { keepGaps: true })).warnings;
      }
    }
    await logActivity(id, me.id, `${me.name} เพิ่ม ${String(b.name).slice(0, 60)}`);
    await bumpVersion(id);
    return NextResponse.json({ id: pid, warnings });
  });
}

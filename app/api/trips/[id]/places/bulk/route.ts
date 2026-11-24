import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, HttpError } from "@/lib/auth";
import { insertPlace } from "@/lib/places";

export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/places/bulk">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson<{ places?: Record<string, unknown>[]; label?: string }>(req);
    const list = Array.isArray(b.places) ? b.places.slice(0, 30) : [];
    if (!list.length) throw new HttpError(400, "ยังไม่ได้เลือกสถานที่");
    const [{ n }] = await sql`select count(*)::int as n from pinpai.places where trip_id = ${id}`;
    if (n + list.length > 300) throw new HttpError(400, "เกินจำนวนสถานที่สูงสุดของทริป");
    let added = 0;
    for (const p of list) if (await insertPlace(id, me.id, p)) added++;
    await logActivity(id, me.id, `${me.name} เพิ่ม ${added} สถานที่${b.label ? ` จาก${String(b.label).slice(0, 40)}` : ""}`);
    await bumpVersion(id);
    return NextResponse.json({ added });
  });
}

import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, str } from "@/lib/auth";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function leg(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const time = typeof o.time === "string" && HHMM.test(o.time) ? o.time : null;
  const flight = str(o.flight, 12)?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
  const place = str(o.place, 80);
  return time || flight || place ? { time, flight, place } : null;
}

/** My own way in and out of the trip (flight / train / bus). Optional — every member fills in their own. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/trips/[id]/travel">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    const travel = { arrive: leg(b.arrive), depart: leg(b.depart) };
    const empty = !travel.arrive && !travel.depart;
    await sql`update pinpai.members set travel = ${empty ? null : sql.json(travel as never)} where id = ${me.id} and trip_id = ${id}`;
    if (!empty) await logActivity(id, me.id, `${me.name} อัปเดตเที่ยวบิน/การเดินทางของตัวเอง ✈️`);
    await bumpVersion(id);
    return NextResponse.json({ ok: true, travel: empty ? null : travel });
  });
}

import { NextResponse } from "next/server";
import { sql, logActivity, bumpVersion } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { handle, readJson, str, newToken, hashToken, MEMBER_COLORS, HttpError } from "@/lib/auth";

// GET ?code= → trip preview (title, dates, member count) for the join screen
export async function GET(req: Request) {
  return handle(async () => {
    rateLimit(req, "joinpeek", 60, 600_000);
    const code = new URL(req.url).searchParams.get("code")?.toUpperCase().slice(0, 12) ?? "";
    const [t] = await sql`select t.title, t.destination, t.start_date::text, t.end_date::text, t.cover_emoji,
      (select count(*) from pinpai.members m where m.trip_id = t.id)::int as members
      from pinpai.trips t where t.invite_code = ${code}`;
    if (!t) throw new HttpError(404, "ไม่พบทริปนี้ ลองเช็กลิงก์เชิญอีกครั้ง");
    return NextResponse.json(t);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    rateLimit(req, "join", 20, 3600_000);
    const b = await readJson(req);
    const code = str(b.code, 12)?.toUpperCase();
    const name = str(b.name, 40);
    if (!code || !name) throw new HttpError(400, "ใส่ชื่อของคุณ");
    const [trip] = await sql`select id from pinpai.trips where invite_code = ${code}`;
    if (!trip) throw new HttpError(404, "ไม่พบทริปนี้");
    const [{ n }] = await sql`select count(*)::int as n from pinpai.members where trip_id = ${trip.id}`;
    if (n >= 30) throw new HttpError(400, "ทริปนี้มีสมาชิกเต็มแล้ว (30 คน)");
    const token = newToken();
    const [m] = await sql`insert into pinpai.members (trip_id, name, color, token_hash)
      values (${trip.id}, ${name}, ${MEMBER_COLORS[n % MEMBER_COLORS.length]}, ${hashToken(token)}) returning id`;
    await logActivity(trip.id, m.id, `${name} เข้าร่วมทริป`);
    await bumpVersion(trip.id);
    return NextResponse.json({ tripId: trip.id, memberId: m.id, token });
  });
}

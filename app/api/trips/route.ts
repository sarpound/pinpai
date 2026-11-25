import { NextResponse } from "next/server";
import { sql, logActivity } from "@/lib/db";
import { handle, readJson, str, newToken, hashToken, newInviteCode, MEMBER_COLORS, HttpError } from "@/lib/auth";
import { geocodeDestination } from "@/lib/geo";
import { rateLimit, limitDb, requireHuman } from "@/lib/ratelimit";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  return handle(async () => {
    rateLimit(req, "create", 10, 3600_000);
    await requireHuman(req);
    await limitDb(req, "create", [{ max: 10, windowSec: 3600 }, { max: 30, windowSec: 86400 }], "สร้างทริปถี่เกินไป ลองใหม่ภายหลัง");
    const b = await readJson(req);
    const title = str(b.title, 120) ?? str(b.destination, 120);
    const name = str(b.name, 40);
    if (!title || !name) throw new HttpError(400, "ใส่ชื่อทริปและชื่อของคุณ");
    const destination = str(b.destination, 120);
    const start = typeof b.start_date === "string" && DATE.test(b.start_date) ? b.start_date : null;
    const end = typeof b.end_date === "string" && DATE.test(b.end_date) ? b.end_date : start;
    if (start && end && end < start) throw new HttpError(400, "วันกลับต้องไม่ก่อนวันไป");
    if (start && end && (Date.parse(end) - Date.parse(start)) / 864e5 > 30) throw new HttpError(400, "ทริปยาวได้สูงสุด 31 วัน");

    let lat: number | null = null, lng: number | null = null;
    const pickLat = typeof b.dest_lat === "number" ? b.dest_lat : NaN, pickLng = typeof b.dest_lng === "number" ? b.dest_lng : NaN;
    if (destination && Number.isFinite(pickLat) && Number.isFinite(pickLng) && Math.abs(pickLat) <= 90 && Math.abs(pickLng) <= 180) {
      lat = pickLat; lng = pickLng; // user picked a suggestion — no extra geocoding
    } else if (destination) {
      const hit = await geocodeDestination(destination);
      if (hit) { lat = hit.lat; lng = hit.lng; }
    }
    const token = newToken();
    const result = await sql.begin(async (tx) => {
      const [trip] = await tx`insert into pinpai.trips (title, destination, dest_lat, dest_lng, start_date, end_date, cover_emoji, invite_code)
        values (${title}, ${destination}, ${lat}, ${lng}, ${start}, ${end}, ${str(b.emoji, 8) ?? "🧭"}, ${newInviteCode()}) returning id, invite_code`;
      const [m] = await tx`insert into pinpai.members (trip_id, name, color, role, token_hash)
        values (${trip.id}, ${name}, ${MEMBER_COLORS[0]}, 'owner', ${hashToken(token)}) returning id`;
      return { tripId: trip.id as string, invite: trip.invite_code as string, memberId: m.id as string };
    });
    await logActivity(result.tripId, result.memberId, `${name} สร้างทริป`);
    return NextResponse.json({ ...result, token });
  });
}

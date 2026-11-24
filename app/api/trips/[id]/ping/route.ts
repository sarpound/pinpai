import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, readJson, HttpError } from "@/lib/auth";

const EMOJI = ["👋", "❤️", "😂", "🔥", "🍜", "⏰", "📸", "🙏", "🎉", "🥺"];

// POST {emoji, to?} → a little reaction that pops over my avatar on everyone's map
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/ping">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    if (typeof b.emoji !== "string" || !EMOJI.includes(b.emoji)) throw new HttpError(400, "อีโมจินี้ใช้ไม่ได้");
    const [{ n }] = await sql`select count(*)::int as n from pinpai.pings where from_member = ${me.id} and created_at > now() - interval '1 minute'`;
    if (n >= 12) throw new HttpError(429, "ส่งรัวไปหน่อย พักแป๊บนึงนะ");
    let to: string | null = null;
    if (typeof b.to === "string") {
      const [m] = await sql`select id from pinpai.members where id = ${b.to} and trip_id = ${id}`.catch(() => []);
      to = m?.id ?? null;
    }
    await sql`insert into pinpai.pings (trip_id, from_member, to_member, emoji) values (${id}, ${me.id}, ${to}, ${b.emoji})`;
    if (Math.random() < 0.05) await sql`delete from pinpai.pings where created_at < now() - interval '1 day'`;
    return NextResponse.json({ ok: true });
  });
}

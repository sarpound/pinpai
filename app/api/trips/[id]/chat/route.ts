import { NextResponse, after } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, readJson, str, num, HttpError } from "@/lib/auth";
import { notify } from "@/lib/push";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["text", "loc", "place", "locreq"];

/** Trip chat. GET ?after=<id> → newer messages (or the latest 80). */
export async function GET(req: Request, ctx: RouteContext<"/api/trips/[id]/chat">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await requireMember(req, id);
    const after = Number(new URL(req.url).searchParams.get("after") ?? 0) || 0;
    const rows = after > 0
      ? await sql`select id, member_id, kind, body, place_id, to_member, lat, lng, created_at from pinpai.messages where trip_id = ${id} and id > ${after} order by id asc limit 200`
      : (await sql`select id, member_id, kind, body, place_id, to_member, lat, lng, created_at from pinpai.messages where trip_id = ${id} order by id desc limit 80`).reverse();
    return NextResponse.json({ messages: rows.map((r) => ({ ...r, id: Number(r.id) })) });
  });
}

/**
 * POST {kind, body?, place_id?, lat?, lng?, to?}
 *  text   — a chat line
 *  loc    — "here I am" (one-shot position, works without live sharing turned on)
 *  place  — share a stop of the trip
 *  locreq — ask one friend (to) where they are
 */
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/chat">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    const kind = KINDS.includes(b.kind as string) ? (b.kind as string) : "text";
    const body = str(b.body, 1000);
    const [{ n }] = await sql`select count(*)::int as n from pinpai.messages where member_id = ${me.id} and created_at > now() - interval '1 minute'`;
    if (n >= 30) throw new HttpError(429, "ส่งรัวไปหน่อย พักแป๊บนึงนะ");
    let placeId: string | null = null, to: string | null = null, lat: number | null = null, lng: number | null = null;
    if (kind === "text" && !body) throw new HttpError(400, "พิมพ์ข้อความก่อนส่ง");
    if (kind === "place") {
      const [p] = typeof b.place_id === "string" && UUID.test(b.place_id) ? await sql`select id from pinpai.places where id = ${b.place_id} and trip_id = ${id}` : [];
      if (!p) throw new HttpError(400, "ไม่พบสถานที่นี้ในทริป");
      placeId = p.id;
    }
    if (kind === "loc") {
      lat = num(b.lat); lng = num(b.lng);
      if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, "อ่านตำแหน่งไม่ได้ ลองเปิด GPS แล้วส่งใหม่");
    }
    if (kind === "locreq") {
      const [m] = typeof b.to === "string" && UUID.test(b.to) ? await sql`select id from pinpai.members where id = ${b.to} and trip_id = ${id}` : [];
      if (!m || m.id === me.id) throw new HttpError(400, "เลือกเพื่อนที่จะขอตำแหน่ง");
      const [dup] = await sql`select 1 from pinpai.messages where trip_id = ${id} and member_id = ${me.id} and to_member = ${m.id} and kind = 'locreq' and created_at > now() - interval '2 minutes'`;
      if (dup) throw new HttpError(429, "เพิ่งขอไปเมื่อกี้ รอเพื่อนตอบแป๊บนึง");
      to = m.id;
    }
    const [row] = await sql`insert into pinpai.messages (trip_id, member_id, kind, body, place_id, to_member, lat, lng)
      values (${id}, ${me.id}, ${kind}, ${body}, ${placeId}, ${to}, ${lat}, ${lng})
      returning id, member_id, kind, body, place_id, to_member, lat, lng, created_at`;
    if (Math.random() < 0.02) await sql`delete from pinpai.messages where trip_id = ${id} and id < (select id from pinpai.messages where trip_id = ${id} order by id desc offset 2000 limit 1)`;
    // phones that have the app closed get a push (sent after we answer, so chatting stays instant)
    after(async () => {
      if (kind === "locreq") return void (await notify(id, { title: `${me.name} ถามว่าคุณอยู่ไหน 📍`, body: "แตะเพื่อเปิดทริปแล้วส่งตำแหน่งครั้งเดียว", tag: `req-${id}` }, { to }));
      let text = body ?? "";
      if (kind === "loc") text = "ส่งตำแหน่งของตัวเองมาในแชท 📍";
      if (kind === "place") { const [p] = await sql`select name from pinpai.places where id = ${placeId}`; text = `ส่งสถานที่: ${p?.name ?? ""}`; }
      await notify(id, { title: me.name, body: text, tag: `chat-${id}` }, { except: me.id });
    });
    return NextResponse.json({ message: { ...row, id: Number(row.id) } });
  });
}

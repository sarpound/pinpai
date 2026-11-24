import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, readJson, HttpError } from "@/lib/auth";
import { vapid, notify } from "@/lib/push";

// only real push services, so the server can't be pointed at arbitrary hosts
const HOSTS = /^https:\/\/([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)\//i;

/** GET → the public key the browser needs to subscribe + whether I already have a device registered */
export async function GET(req: Request, ctx: RouteContext<"/api/trips/[id]/push">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const [{ n }] = await sql`select count(*)::int as n from pinpai.push_subs where member_id = ${me.id}`;
    return NextResponse.json({ key: (await vapid()).publicKey, devices: n });
  });
}

/** POST {subscription} → remember this device for this trip; sends one test notification so the user sees it works */
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/push">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    const s = (b.subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof s.endpoint !== "string" || s.endpoint.length > 1000 || !HOSTS.test(s.endpoint) || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string"
      || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) throw new HttpError(400, "เปิดแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง");
    const [{ n }] = await sql`select count(*)::int as n from pinpai.push_subs where member_id = ${me.id}`;
    if (n >= 8) await sql`delete from pinpai.push_subs where id in (select id from pinpai.push_subs where member_id = ${me.id} order by id asc limit ${n - 7})`;
    await sql`insert into pinpai.push_subs (trip_id, member_id, endpoint, p256dh, auth) values (${id}, ${me.id}, ${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth})
      on conflict (member_id, endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth`;
    const sent = b.quiet === true ? 0 : await notify(id, { title: "ปักไป", body: "เปิดแจ้งเตือนแล้ว เพื่อนทักหรือถามหาเมื่อไหร่จะเด้งที่นี่", tag: "hello" }, { to: me.id });
    return NextResponse.json({ ok: true, sent });
  });
}

/** DELETE {endpoint} → stop notifying this device */
export async function DELETE(req: Request, ctx: RouteContext<"/api/trips/[id]/push">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req).catch(() => ({} as Record<string, unknown>));
    if (typeof b.endpoint === "string") await sql`delete from pinpai.push_subs where member_id = ${me.id} and endpoint = ${b.endpoint}`;
    else await sql`delete from pinpai.push_subs where member_id = ${me.id} and trip_id = ${id}`;
    return NextResponse.json({ ok: true });
  });
}

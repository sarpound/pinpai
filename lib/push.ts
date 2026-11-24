import webpush from "web-push";
import { sql } from "./db";

type Keys = { publicKey: string; privateKey: string };
let cached: Keys | null = null;

/** The server's Web Push key pair. Created once on first use and kept in the pinpai schema (never in code or logs). */
export async function vapid(): Promise<Keys> {
  if (cached) return cached;
  let [row] = await sql`select value from pinpai.app_config where key = 'vapid'`;
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    await sql`insert into pinpai.app_config (key, value) values ('vapid', ${sql.json(k as never)}) on conflict (key) do nothing`;
    [row] = await sql`select value from pinpai.app_config where key = 'vapid'`;
  }
  cached = row.value as Keys;
  return cached;
}

/**
 * Notify trip members who turned notifications on. `to` = one member, otherwise everyone except `except`.
 * Never throws: a dead subscription is removed, everything else is ignored (push is a nice-to-have).
 */
export async function notify(tripId: string, msg: { title: string; body: string; tag?: string }, opts: { except?: string | null; to?: string | null } = {}) {
  try {
    const subs = opts.to
      ? await sql`select id, endpoint, p256dh, auth from pinpai.push_subs where trip_id = ${tripId} and member_id = ${opts.to}`
      : await sql`select id, endpoint, p256dh, auth from pinpai.push_subs where trip_id = ${tripId} and member_id is distinct from ${opts.except ?? null}`;
    if (!subs.length) return 0;
    const k = await vapid();
    const payload = JSON.stringify({ title: msg.title.slice(0, 80), body: msg.body.slice(0, 180), tag: msg.tag ?? `trip-${tripId}`, url: `/t/${tripId}` });
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { vapidDetails: { subject: "https://pinpai-sarpounds-projects.vercel.app", publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 3600, urgency: "high", timeout: 8000 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sql`delete from pinpai.push_subs where id = ${s.id}`.catch(() => {});
      }
    }));
    return sent;
  } catch { return 0; }
}

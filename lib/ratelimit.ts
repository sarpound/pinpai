import { createHash } from "node:crypto";
import { HttpError } from "./auth";
import { sql } from "./db";

export function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

// Fast first layer: per instance, in memory (free, catches bursts before touching the database).
const hits = new Map<string, number[]>();
export function rateLimit(req: Request, bucket: string, max: number, windowMs: number) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, "ใช้งานถี่เกินไป รอสักครู่แล้วลองใหม่");
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
}

/**
 * Our own automated QA: a short-lived ticket whose hash an operator put in pinpai.qa_tickets.
 * Skips bot checks and IP limits for that run only; nothing is hard-coded or kept in env.
 */
export async function isQa(req: Request) {
  const got = req.headers.get("x-pp-qa");
  if (!got || got.length < 32 || got.length > 128) return false;
  const h = createHash("sha256").update(got).digest("hex");
  const [row] = await sql`select 1 from pinpai.qa_tickets where token_hash = ${h} and expires_at > now()`.catch(() => []);
  return !!row;
}

const WAIT = (sec: number) => sec >= 86400 ? "พรุ่งนี้" : sec >= 3600 ? "อีกสักชั่วโมง" : "อีกสักครู่";

/**
 * Durable limiter shared by every instance: fixed windows counted in Postgres (pinpai.rate_hits).
 * The IP is stored only as a salted hash. Rules are checked together; any one over its max → 429.
 */
export async function limitDb(req: Request, bucket: string, rules: { max: number; windowSec: number }[], message?: string) {
  if (await isQa(req)) return;
  const key = createHash("sha256").update(`${process.env.PINPAI_IP_SALT ?? process.env.DATABASE_URL?.slice(-16) ?? "pinpai"}:${clientIp(req)}`).digest("hex").slice(0, 32);
  for (const r of rules) {
    const [row] = await sql`insert into pinpai.rate_hits (bucket, key, window_start, n)
      values (${`${bucket}:${r.windowSec}`}, ${key}, to_timestamp(floor(extract(epoch from now()) / ${r.windowSec}) * ${r.windowSec}), 1)
      on conflict (bucket, key, window_start) do update set n = pinpai.rate_hits.n + 1 returning n`;
    if (row.n > r.max) throw new HttpError(429, message ?? `ใช้งานถี่เกินไป ลองใหม่${WAIT(r.windowSec)}`);
  }
  if (Math.random() < 0.01) await sql`delete from pinpai.rate_hits where window_start < now() - interval '2 days'`.catch(() => {});
}

/**
 * Vercel BotID on the expensive buttons (create trip, plan with AI). Invisible to people.
 * Fails open if the check itself errors, so a BotID outage never locks real users out.
 */
export async function requireHuman(req: Request) {
  if (await isQa(req)) return;
  try {
    const { checkBotId } = await import("botid/server");
    const v = await checkBotId();
    if (v.isBot) throw new HttpError(403, "ระบบตรวจพบการใช้งานอัตโนมัติ ลองรีเฟรชหน้าแล้วกดใหม่อีกครั้ง");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.warn("[botid] check failed, allowing", (e as Error).message);
  }
}

import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { sql } from "./db";

export const MEMBER_COLORS = ["#E8553A", "#1B7F79", "#7A4DD8", "#D4911C", "#2F6FE0", "#C23A7A", "#3E8E3A", "#8A5A2B"];

export function newToken() {
  return randomBytes(24).toString("base64url");
}
export function hashToken(t: string) {
  return createHash("sha256").update(t).digest("hex");
}
export function newInviteCode() {
  // no ambiguous chars
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export type Member = { id: string; trip_id: string; name: string; color: string; role: "owner" | "editor" };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(v: string) {
  if (!UUID.test(v)) throw new HttpError(404, "ไม่พบข้อมูล");
}

/** Resolve the member for this trip from the x-pp-token header, or throw 401. */
export async function requireMember(req: Request, tripId: string): Promise<Member> {
  assertUuid(tripId);
  const token = req.headers.get("x-pp-token");
  if (!token || token.length > 100) throw new HttpError(401, "กรุณาเข้าร่วมทริปก่อน");
  const rows = await sql<(Member & { stale: boolean })[]>`
    select id, trip_id, name, color, role, (last_seen is null or last_seen < now() - interval '1 minute') as stale
    from pinpai.members where token_hash = ${hashToken(token)} and trip_id = ${tripId}`;
  if (!rows[0]) throw new HttpError(401, "ลิงก์นี้ไม่มีสิทธิ์เข้าทริปนี้");
  // every member polls every 4s — only write last_seen once a minute (shared DB with Marbooking)
  const { stale, ...m } = rows[0];
  if (stale) await sql`update pinpai.members set last_seen = now() where id = ${m.id}`;
  return m;
}

export function handle(fn: () => Promise<Response>) {
  return fn().catch((e: unknown) => {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error(e);
    const msg = String((e as Error)?.message ?? "");
    if (/Gateway|AI_APICallError|credit card|customer_verification|budget/i.test(msg + String((e as { name?: string })?.name)))
      return NextResponse.json({ error: "ฟีเจอร์ AI ใช้งานไม่ได้ชั่วคราว ฟีเจอร์อื่นยังใช้ได้ตามปกติ" }, { status: 503 });
    return NextResponse.json({ error: "ระบบขัดข้อง ลองใหม่อีกครั้ง" }, { status: 500 });
  });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "ข้อมูลไม่ถูกต้อง");
  }
}

export function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}
export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

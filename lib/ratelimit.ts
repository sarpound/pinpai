import { HttpError } from "./auth";

// Best-effort per-instance IP limiter (Fluid compute reuses instances). Pair with Vercel WAF for hard limits.
const hits = new Map<string, number[]>();
export function rateLimit(req: Request, bucket: string, max: number, windowMs: number) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, "ใช้งานถี่เกินไป รอสักครู่แล้วลองใหม่");
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
}

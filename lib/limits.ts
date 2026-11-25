import { sql } from "./db";
import { HttpError } from "./auth";
import { setEconomy, type Usage } from "./ai";
import { limitDb } from "./ratelimit";

// Spend guard for the AI features. Defaults sized to AI Gateway's free monthly credit ($5).
// When the month's metered spend reaches the cap, AI features switch off until the 1st.
const MONTHLY_USD = Number(process.env.PINPAI_AI_MONTHLY_USD ?? 5);
const GLOBAL_DAILY = Number(process.env.PINPAI_AI_DAILY_CAP ?? 1500);
const PER_TRIP_DAILY = Number(process.env.PINPAI_AI_TRIP_DAILY ?? 40);
// USD per 1M tokens (Claude Haiku 5.5 via AI Gateway, ≤100k-token tier)
const PRICE_IN = Number(process.env.PINPAI_PRICE_IN ?? 0.1);
const PRICE_OUT = Number(process.env.PINPAI_PRICE_OUT ?? 0.5);

export const AI_OFF_MESSAGE = "ฟีเจอร์ AI ปิดชั่วคราว (ใช้ครบโควตาฟรีของเดือนนี้แล้ว) ฟีเจอร์อื่นยังใช้ได้ตามปกติ";

/**
 * Check caps, open a meter row, and return a recorder that stores the real token cost.
 * Counts only 'meter' rows (import also writes a 'done' cache row).
 */
export async function aiBudget(tripId: string, kind = "ai", req?: Request) {
  // per person (IP), shared by every instance: 120 AI calls/day, 30/10 min — a real trip planner never gets close
  if (req) await limitDb(req, "ai", [{ max: 30, windowSec: 600 }, { max: 120, windowSec: 86400 }], "ใช้ AI ถี่เกินไป พักสักครู่แล้วลองใหม่");
  const [r] = await sql`select
      count(*) filter (where trip_id = ${tripId} and created_at > now() - interval '24 hours')::int as trip_day,
      count(*) filter (where created_at > now() - interval '24 hours')::int as all_day,
      coalesce(sum((result->>'cost')::numeric) filter (where created_at >= date_trunc('month', now())), 0)::float8 as month_cost
    from pinpai.imports where status = 'meter' and created_at >= least(date_trunc('month', now()), now() - interval '24 hours')`;
  if (r.month_cost >= MONTHLY_USD) throw new HttpError(503, AI_OFF_MESSAGE);
  setEconomy(r.month_cost >= MONTHLY_USD * 0.8);
  if (r.trip_day >= PER_TRIP_DAILY) throw new HttpError(429, "ทริปนี้ใช้ AI ครบโควตาวันนี้แล้ว ลองใหม่พรุ่งนี้");
  if (r.all_day >= GLOBAL_DAILY) throw new HttpError(429, "ระบบ AI มีคนใช้เยอะเกินไปวันนี้ ลองใหม่ภายหลัง");
  const [row] = await sql`insert into pinpai.imports (trip_id, platform, status, result) values (${tripId}, ${kind}, 'meter', '{}'::jsonb) returning id`;
  let total = { inputTokens: 0, outputTokens: 0, cost: 0, model: "" };
  return async (u: Usage) => {
    const add = u.cost ?? ((u.inputTokens ?? 0) * PRICE_IN + (u.outputTokens ?? 0) * PRICE_OUT) / 1e6;
    total = { inputTokens: total.inputTokens + (u.inputTokens ?? 0), outputTokens: total.outputTokens + (u.outputTokens ?? 0), cost: total.cost + add, model: u.model ?? total.model };
    await sql`update pinpai.imports set result = ${sql.json(total as never)} where id = ${row.id}`;
  };
}

export async function aiStatus() {
  const [r] = await sql`select coalesce(sum((result->>'cost')::numeric), 0)::float8 as cost, count(*)::int as calls
    from pinpai.imports where status = 'meter' and created_at >= date_trunc('month', now())`;
  return { enabled: r.cost < MONTHLY_USD, used_usd: Number(r.cost.toFixed(4)), cap_usd: MONTHLY_USD, calls: r.calls };
}

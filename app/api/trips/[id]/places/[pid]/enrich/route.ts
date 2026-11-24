import { NextResponse } from "next/server";
import { sql, bumpVersion } from "@/lib/db";
import { handle, requireMember, assertUuid, HttpError } from "@/lib/auth";
import { describePlace } from "@/lib/ai";
import { aiBudget } from "@/lib/limits";

export const maxDuration = 60;

export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/places/[pid]/enrich">) {
  return handle(async () => {
    const { id, pid } = await ctx.params;
    await requireMember(req, id);
    assertUuid(pid);
    const [p] = await sql`select p.name, p.category, p.address, p.details, p.lat::float8 as lat, p.lng::float8 as lng, t.destination from pinpai.places p
      join pinpai.trips t on t.id = p.trip_id where p.id = ${pid} and p.trip_id = ${id}`;
    if (!p) throw new HttpError(404, "ไม่พบสถานที่");
    if (p.details?.summary) return NextResponse.json({ details: p.details });
    // reuse a summary already generated for the same place in any trip (last 60 days, within ~2 km) — no AI cost
    const [cached] = await sql`select details from pinpai.places
      where lower(name) = lower(${p.name}) and details ? 'summary' and updated_at > now() - interval '60 days'
        and (${p.lat}::float8 is null or lat is null or (abs(lat - ${p.lat}) < 0.02 and abs(lng - ${p.lng}) < 0.02))
      limit 1`;
    let d: Record<string, unknown>;
    if (cached) {
      const { why: _w, ...rest } = cached.details as Record<string, unknown>;
      d = rest;
    } else {
      const meter = await aiBudget(id, "enrich");
      d = await describePlace({ name: p.name, category: p.category, address: p.address, destination: p.destination }, meter);
    }
    const details = { ...(p.details ?? {}), ...d, ai: true, generated_at: new Date().toISOString() };
    await sql`update pinpai.places set details = ${sql.json(details as never)},
      duration_min = coalesce(duration_min, ${(d.duration_min as number | null) ?? null}) where id = ${pid}`;
    await bumpVersion(id);
    return NextResponse.json({ details });
  });
}

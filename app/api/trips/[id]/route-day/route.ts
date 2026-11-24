import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, num, HttpError } from "@/lib/auth";
import { routeDay, type Mode } from "@/lib/routing";
import { stayForDay } from "@/lib/stays";
import { updateCalib } from "@/lib/retime";

export const dynamic = "force-dynamic";

/** Road route for one day: hotel → stops (in order) → hotel, with per-leg time/mode and navigation links. */
export async function GET(req: Request, ctx: RouteContext<"/api/trips/[id]/route-day">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await requireMember(req, id);
    const day = num(new URL(req.url).searchParams.get("day"));
    if (day == null || day < 0 || day > 60) throw new HttpError(400, "ระบุวัน");
    const [trip] = await sql`select prefs, (end_date - start_date) as span from pinpai.trips where id = ${id}`;
    const mode = (["transit", "taxi", "drive", "walk"].includes(trip.prefs?.mode) ? trip.prefs.mode : "taxi") as Mode;
    const stops = await sql`select id, name, lat::float8 as lat, lng::float8 as lng from pinpai.places
      where trip_id = ${id} and day_index = ${day} and category <> 'stay' and lat is not null order by sort_order, created_at`;
    const stays = await sql`select id, name, lat::float8 as lat, lng::float8 as lng, day_index, details from pinpai.places
      where trip_id = ${id} and category = 'stay' and lat is not null`;
    const hotel = stayForDay(stays as never, day);
    // arrival day starts at the airport and ends at the hotel; departure day leaves the hotel and doesn't come back
    const span = trip.span == null ? null : Number(trip.span);
    const hotelStart = !!hotel && stops.length > 0 && !(day === 0 && span != null && span > 0);
    const hotelEnd = !!hotel && stops.length > 0 && !(span != null && span > 0 && day === span);
    const pts = [...(hotelStart ? [hotel!] : []), ...stops, ...(hotelEnd ? [hotel!] : [])].map((p) => ({ lat: p.lat as number, lng: p.lng as number }));
    const r = await routeDay(pts, mode, trip.prefs?.calib ?? null);
    // learn this city's real road detour and driving speed from routed days (used by the planner and the editor)
    if (r.exact && r.samples?.length) {
      const next = updateCalib(trip.prefs?.calib, r.samples);
      const prev = trip.prefs?.calib;
      if (next && (!prev || Math.abs((next.detour ?? 0) - (prev.detour ?? 0)) >= 0.02 || Math.abs((next.kmh ?? 0) - (prev.kmh ?? 0)) >= 0.5))
        await sql`update pinpai.trips set prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ calib: next } as never)} where id = ${id}`.catch(() => {});
    }
    const { samples: _s, ...out } = r;
    return NextResponse.json({ ...out, mode, hotel: hotel ? { id: hotel.id, name: hotel.name } : null, hotelStart, hotelEnd, stopIds: stops.map((s) => s.id) });
  });
}

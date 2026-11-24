import { NextResponse } from "next/server";
import { handle, requireMember } from "@/lib/auth";
import { fillTripPhotos, fixTripPins } from "@/lib/photos";
import { verifyTripPlaces } from "@/lib/verify";

export const maxDuration = 30;

/** Fill in photos for places that haven't been checked yet (batch of 12). Also re-pins places saved from an AI guess. Free — no AI. */
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/photos">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await requireMember(req, id);
    // pins first (a photo is matched by location), then photos
    const pins = await fixTripPins(id, 10).catch(() => ({ moved: 0, remaining: 0 }));
    if (pins.remaining) return NextResponse.json({ updated: pins.moved, remaining: pins.remaining, pins: true });
    const r = await fillTripPhotos(id, 12);
    // sights the planner had no time to check: real / known / still open (Wikipedia + Wikidata), a few per call
    const v = r.remaining ? null : await verifyTripPlaces(id, Date.now() + 15_000, 8).catch(() => null);
    if (v?.checked) r.updated += 1;
    return NextResponse.json({ updated: r.updated + pins.moved, remaining: r.remaining });
  });
}

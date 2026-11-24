import { NextResponse } from "next/server";
import { aiStatus } from "@/lib/limits";
import { activeModel } from "@/lib/ai";
export const dynamic = "force-dynamic";
// Public: lets the UI hide AI buttons once the monthly free quota is used up.
export async function GET() {
  try {
    const s = await aiStatus();
    return NextResponse.json({ enabled: s.enabled, model: activeModel(), used_usd: s.used_usd, cap_usd: s.cap_usd, calls: s.calls }, { headers: { "Cache-Control": "public, s-maxage=30" } });
  } catch {
    return NextResponse.json({ enabled: true });
  }
}

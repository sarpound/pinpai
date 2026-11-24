import { NextResponse } from "next/server";

// THB per 1 unit of a currency, from a free daily feed; cached at the edge for 12h.
export async function GET(req: Request) {
  const code = (new URL(req.url).searchParams.get("code") ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return NextResponse.json({ error: "bad code" }, { status: 400 });
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/THB", { next: { revalidate: 43200 }, signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { rates?: Record<string, number> };
    const per = j.rates?.[code];
    if (!per) throw new Error("no rate");
    return NextResponse.json({ code, thb: 1 / per }, { headers: { "Cache-Control": "public, s-maxage=43200, stale-while-revalidate=86400" } });
  } catch {
    return NextResponse.json({ code, thb: null }, { headers: { "Cache-Control": "public, s-maxage=300" } });
  }
}

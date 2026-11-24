import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const [r] = await sql`select 1 as u`;
    return NextResponse.json({ ok: r.u === 1 });
  } catch (e) {
    console.error(e); // don't echo DB errors (host/role details) to the public
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

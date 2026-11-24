import { NextResponse } from "next/server";
import { sql, bumpVersion, logActivity } from "@/lib/db";
import { handle, requireMember, readJson, num, str, HttpError, assertUuid } from "@/lib/auth";

const EXPENSE_CATS = ["food", "transport", "stay", "tickets", "shopping", "other"];

// POST {amount, category, note?, paid_by?, split?: memberIds, spent_on?} → add; DELETE ?eid= → remove
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/expenses">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    const amount = num(b.amount);
    if (amount == null || !(amount > 0) || amount >= 1e8) throw new HttpError(400, "ใส่จำนวนเงินให้ถูกต้อง");
    const members = (await sql`select id, name from pinpai.members where trip_id = ${id}`) as unknown as { id: string; name: string }[];
    const ids = new Set(members.map((m) => m.id));
    const paidBy = typeof b.paid_by === "string" && ids.has(b.paid_by) ? b.paid_by : me.id;
    let split = Array.isArray(b.split) ? (b.split as unknown[]).filter((x): x is string => typeof x === "string" && ids.has(x)) : [];
    if (!split.length) split = [...ids];
    const cat = typeof b.category === "string" && EXPENSE_CATS.includes(b.category) ? b.category : "other";
    const day = typeof b.spent_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.spent_on) ? b.spent_on : null;
    const [row] = await sql`insert into pinpai.expenses (trip_id, paid_by, amount, category, note, split, created_by, spent_on)
      values (${id}, ${paidBy}, ${Math.round(amount * 100) / 100}, ${cat}, ${str(b.note, 120)}, ${split}, ${me.id}, ${day}) returning id`;
    const payer = members.find((m) => m.id === paidBy)?.name ?? me.name;
    await logActivity(id, me.id, `${payer} จ่าย ฿${Math.round(amount).toLocaleString("en-US")}${str(b.note, 40) ? ` ค่า${str(b.note, 40)}` : ""}`);
    await bumpVersion(id);
    return NextResponse.json({ ok: true, id: row.id });
  });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/trips/[id]/expenses">) {
  return handle(async () => {
    const { id } = await ctx.params;
    await requireMember(req, id);
    const eid = new URL(req.url).searchParams.get("eid") ?? "";
    assertUuid(eid);
    await sql`delete from pinpai.expenses where id = ${eid} and trip_id = ${id}`;
    await bumpVersion(id);
    return NextResponse.json({ ok: true });
  });
}

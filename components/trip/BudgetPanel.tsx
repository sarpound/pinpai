"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { avatarDataUrl } from "@/lib/client/avatar";
import { balances, baht, guessCurrency, settle } from "@/lib/client/money";
import { Button } from "@/components/ui/Field";
import { IconTrash, IconWand } from "@/components/icons";
import type { Expense, MemberT, Trip } from "@/lib/types";

const CATS = [
  { id: "food", emoji: "🍜", label: "กิน", color: "#E8553A" },
  { id: "transport", emoji: "🚕", label: "เดินทาง", color: "#2F6FE0" },
  { id: "stay", emoji: "🏨", label: "ที่พัก", color: "#7A4DD8" },
  { id: "tickets", emoji: "🎟️", label: "เที่ยว", color: "#1B7F79" },
  { id: "shopping", emoji: "🛍️", label: "ช้อป", color: "#D4911C" },
  { id: "other", emoji: "✨", label: "อื่นๆ", color: "#5D6570" },
];
const cat = (id: string) => CATS.find((c) => c.id === id) ?? CATS[5];

export default function BudgetPanel({ trip, members, expenses, me, token, days, onChanged, onPlan, toast }: {
  trip: Trip; members: MemberT[]; expenses: Expense[]; me: string; token: string; days: number;
  onChanged: () => void; onPlan: () => void; toast: (s: string) => void;
}) {
  const prefs = trip.prefs ?? {};
  const n = Math.max(1, members.length, prefs.travelers ?? 1);
  const per = prefs.budget_per ?? "person";
  const budgetPP = prefs.budget_amount ? (per === "group" ? prefs.budget_amount / n : prefs.budget_amount) : null;
  const budgetAll = budgetPP != null ? budgetPP * n : null;

  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  const pct = budgetAll ? spent / budgetAll : 0;

  // ---- budget editor
  const [editing, setEditing] = useState(!prefs.budget_amount);
  const [amt, setAmt] = useState(prefs.budget_amount ? String(prefs.budget_amount) : "");
  const [amtPer, setAmtPer] = useState<"person" | "group">(per);
  async function saveBudget(e: React.FormEvent) {
    e.preventDefault();
    const a = Number(amt.replace(/[^\d.]/g, ""));
    try {
      await api(`/api/trips/${trip.id}`, { token, method: "PATCH", body: { prefs: { budget_amount: a > 0 ? a : null, budget_per: amtPer } } });
      setEditing(false); onChanged(); toast(a > 0 ? "ตั้งงบแล้ว" : "ลบงบแล้ว");
    } catch (err) { toast((err as Error).message); }
  }

  // ---- AI estimate for the current plan
  const c = trip.guide?.costs;
  const est = useMemo(() => {
    if (!c) return null;
    const nights = Math.max(0, days - 1), rooms = Math.ceil(n / 2);
    const rows = [
      { label: "ตั๋วเครื่องบิน/เดินทางไปกลับ", v: c.flights },
      { label: `ที่พัก ${nights} คืน (แชร์ห้อง 2 คน)`, v: (c.stay_per_night * nights * rooms) / n },
      { label: `อาหาร ${days} วัน`, v: c.food_per_day * days },
      { label: "เดินทางในเมือง", v: c.local_transport_per_day * days },
      { label: "ค่าเข้าชม", v: c.tickets_total },
    ].filter((r) => r.v > 0);
    return { rows, total: rows.reduce((s, r) => s + r.v, 0) };
  }, [c, days, n]);

  // ---- quick add
  const local = guessCurrency(trip.destination);
  const [rate, setRate] = useState<number | null>(null);
  const [inLocal, setInLocal] = useState(false);
  useEffect(() => {
    if (!local) return;
    fetch(`/api/fx?code=${local.code}`).then((r) => r.json()).then((j) => { if (j.thb) { setRate(j.thb); setInLocal(true); } }).catch(() => {});
  }, [local?.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const [x, setX] = useState("");
  const [xc, setXc] = useState("food");
  const [payer, setPayer] = useState(me);
  const [split, setSplit] = useState<string[]>(members.map((m) => m.id));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const raw = Number(x.replace(/[^\d.]/g, "")) || 0;
  const thb = inLocal && rate ? raw * rate : raw;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!(thb > 0)) return toast("ใส่จำนวนเงินก่อน");
    setBusy(true);
    const orig = inLocal && local ? `${local.sym}${raw.toLocaleString("en-US")}` : "";
    try {
      await api(`/api/trips/${trip.id}/expenses`, { token, body: { amount: Math.round(thb * 100) / 100, category: xc, paid_by: payer, split,
        note: [note.trim(), orig].filter(Boolean).join(" · ") || null } });
      setX(""); setNote(""); onChanged(); toast(`บันทึก ${baht(thb)} แล้ว`);
    } catch (err) { toast((err as Error).message); }
    setBusy(false);
  }
  const [arm, setArm] = useState<string | null>(null);
  async function del(id: string) {
    if (arm !== id) { setArm(id); window.setTimeout(() => setArm((a) => (a === id ? null : a)), 3000); return; } // tap twice: no accidental deletes
    try { await api(`/api/trips/${trip.id}/expenses?eid=${id}`, { token, method: "DELETE" }); onChanged(); } catch (err) { toast((err as Error).message); }
  }

  const name = (id: string | null) => (id === me ? "คุณ" : members.find((m) => m.id === id)?.name ?? "ใครสักคน");
  const bals = useMemo(() => balances(members.map((m) => m.id), expenses), [members, expenses]);
  const moves = useMemo(() => settle(bals), [bals]);
  const byCat = useMemo(() => CATS.map((k) => ({ ...k, v: expenses.filter((e) => e.category === k.id).reduce((s, e) => s + e.amount, 0) })).filter((k) => k.v > 0), [expenses]);

  const tone = pct > 1 ? "bg-danger" : pct > 0.8 ? "bg-[#D4911C]" : "bg-accent";

  return (
    <div className="space-y-7 pb-6">
      {/* where the money stands */}
      <section className="rounded-[20px] bg-ink p-4 text-white">
        <p className="text-[13px] text-white/70">ใช้ไปแล้วทั้งแก๊ง</p>
        <p className="font-display text-[32px] font-semibold leading-10 tnum">{baht(spent)}</p>
        {budgetAll ? (
          <>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="ใช้งบไปแล้ว">
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct * 100)}%` }} />
            </div>
            <p className="mt-2 flex justify-between text-[13px] text-white/80 tnum">
              <span>{pct > 1 ? `เกินงบ ${baht(spent - budgetAll)}` : `เหลือ ${baht(budgetAll - spent)}`}</span>
              <span>งบ {baht(budgetAll)} · คนละ {baht(budgetPP!)}</span>
            </p>
          </>
        ) : <p className="mt-1 text-[13px] text-white/70">ยังไม่ได้ตั้งงบ ตั้งไว้แล้วจะเตือนก่อนเกิน</p>}
        {!editing && <button onClick={() => setEditing(true)} className="mt-3 h-9 rounded-full bg-white/10 px-4 text-[13px] font-semibold hover:bg-white/20">{prefs.budget_amount ? "แก้งบ" : "ตั้งงบทริป"}</button>}
        {editing && (
          <form onSubmit={saveBudget} className="mt-3 space-y-2">
            <div className="grid grid-cols-2 gap-1 rounded-full bg-white/10 p-1" role="radiogroup" aria-label="งบนี้คิดแบบ">
              {(["person", "group"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={amtPer === k} onClick={() => setAmtPer(k)}
                  className={`h-9 rounded-full text-[14px] font-semibold ${amtPer === k ? "bg-lime text-ink" : "text-white"}`}>{k === "person" ? "ต่อคน" : "รวมทั้งแก๊ง"}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <label className="flex h-12 min-w-0 flex-1 items-center rounded-full bg-white px-4 text-ink">
                <span className="mr-1 font-semibold">฿</span>
                <input inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder={amtPer === "person" ? "เช่น 15000" : "เช่น 60000"}
                  className="min-w-0 flex-1 bg-transparent text-[16px] outline-none focus-visible:outline-none tnum" aria-label="จำนวนงบ" />
              </label>
              <button className="h-12 shrink-0 rounded-full bg-lime px-5 font-semibold text-ink">บันทึก</button>
            </div>
          </form>
        )}
      </section>

      {/* what the plan should cost */}
      {est && (
        <section>
          <h3 className="text-[17px] font-semibold">แผนนี้น่าจะใช้ประมาณ</h3>
          <p className="mt-1 font-display text-[24px] font-semibold tnum">{baht(est.total)} <span className="text-[14px] font-normal text-muted">ต่อคน</span></p>
          {budgetPP != null && (
            <p className={`mt-1 inline-flex rounded-full px-3 py-1 text-[13px] font-semibold ${est.total <= budgetPP ? "bg-accent-tint text-accent" : "bg-danger/10 text-danger"}`}>
              {est.total <= budgetPP ? `อยู่ในงบ เหลือคนละ ${baht(budgetPP - est.total)}` : `เกินงบคนละ ${baht(est.total - budgetPP)}`}
            </p>
          )}
          <ul className="mt-3 divide-y divide-line rounded-[16px] border border-line">
            {est.rows.map((r) => (
              <li key={r.label} className="flex justify-between px-3 py-2.5 text-[14px]"><span className="text-muted">{r.label}</span><span className="font-semibold tnum">{baht(r.v)}</span></li>
            ))}
          </ul>
          {c?.note && <p className="mt-2 text-[13px] text-muted">💡 {c.note}</p>}
          {budgetPP != null && est.total > budgetPP && (
            <Button variant="secondary" className="mt-3 w-full" onClick={onPlan}><IconWand size={18} />จัดทริปใหม่ให้พอดีงบ</Button>
          )}
        </section>
      )}
      {!est && (
        <section className="rounded-[16px] border border-dashed border-line p-4">
          <p className="text-[14px] text-muted">ให้ระบบจัดทริปก่อน แล้วจะประมาณค่าใช้จ่ายต่อคนให้ แยกเป็นที่พัก อาหาร และค่าเดินทาง</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={onPlan}><IconWand size={16} />จัดทริปพร้อมคุมงบ</Button>
        </section>
      )}

      {/* quick add */}
      <section>
        <h3 className="text-[17px] font-semibold">จดค่าใช้จ่าย</h3>
        <form onSubmit={add} className="mt-3 space-y-3">
          <div className="flex gap-2">
            <label className="flex h-14 min-w-0 flex-1 items-center rounded-[16px] border border-line bg-surface px-4 focus-within:border-ink">
              <span className="mr-1.5 text-[20px] font-semibold">{inLocal && local ? local.sym : "฿"}</span>
              <input inputMode="decimal" value={x} onChange={(e) => setX(e.target.value)} placeholder="0" aria-label="จำนวนเงิน"
                className="min-w-0 flex-1 bg-transparent font-display text-[22px] font-semibold outline-none focus-visible:outline-none tnum" />
            </label>
            {local && rate && (
              <div className="grid shrink-0 grid-cols-2 gap-1 rounded-[16px] bg-sunken p-1" role="radiogroup" aria-label="สกุลเงิน">
                {[false, true].map((l) => (
                  <button key={String(l)} type="button" role="radio" aria-checked={inLocal === l} onClick={() => setInLocal(l)}
                    className={`w-12 rounded-[12px] text-[15px] font-semibold ${inLocal === l ? "bg-surface shadow-[var(--shadow-1)]" : "text-muted"}`}>{l ? local.sym : "฿"}</button>
                ))}
              </div>
            )}
          </div>
          {inLocal && local && rate && raw > 0 && <p className="-mt-1 text-[13px] text-muted tnum">≈ {baht(thb)} (1 {local.th} ≈ ฿{rate.toFixed(2)})</p>}
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="หมวด">
            {CATS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={xc === k.id} onClick={() => setXc(k.id)}
                className={`h-11 rounded-full border text-[14px] font-medium ${xc === k.id ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}>{k.emoji} {k.label}</button>
            ))}
          </div>
          {members.length > 1 && (
            <>
              <People label="ใครจ่าย" members={members} me={me} picked={[payer]} onPick={(id) => setPayer(id)} />
              <People label={`หารกับ ${split.length} คน`} members={members} me={me} picked={split}
                onPick={(id) => setSplit((s) => (s.includes(id) ? (s.length > 1 ? s.filter((y) => y !== id) : s) : [...s, id]))} />
            </>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} placeholder="จ่ายค่าอะไร (ไม่ใส่ก็ได้)"
            className="h-12 w-full rounded-full border border-line bg-surface px-4 text-[16px] outline-none focus:border-ink" />
          <Button type="submit" className="w-full" disabled={busy || !(thb > 0)}>{busy ? "กำลังบันทึก…" : thb > 0 ? `บันทึก ${baht(thb)}` : "บันทึก"}</Button>
        </form>
      </section>

      {/* settle up */}
      {expenses.length > 0 && members.length > 1 && (
        <section>
          <h3 className="text-[17px] font-semibold">ใครต้องโอนให้ใคร</h3>
          {moves.length === 0 ? <p className="mt-1 text-[14px] text-muted">เคลียร์กันครบแล้ว ไม่มีใครติดใคร</p> : (
            <ul className="mt-3 space-y-2">
              {moves.map((m, i) => (
                <li key={i} className="flex items-center gap-2 rounded-[16px] bg-sunken px-3 py-2.5 text-[14px]">
                  <img src={avatarDataUrl(m.from, members.find((x) => x.id === m.from)?.color ?? "#5D6570")} alt="" className="size-7 rounded-full" />
                  <span className="min-w-0 flex-1"><b>{name(m.from)}</b> โอนให้ <b>{name(m.to)}</b></span>
                  <span className="font-semibold tnum">{baht(m.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* where it went */}
      {expenses.length > 0 && (
        <section>
          <h3 className="text-[17px] font-semibold">ใช้ไปกับอะไร</h3>
          <div className="mt-3 flex h-3 overflow-hidden rounded-full" aria-hidden="true">
            {byCat.map((k) => <span key={k.id} style={{ width: `${(k.v / spent) * 100}%`, background: k.color }} />)}
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
            {byCat.map((k) => <li key={k.id} className="flex justify-between"><span>{k.emoji} {k.label}</span><span className="font-semibold tnum">{baht(k.v)}</span></li>)}
          </ul>
          <ul className="mt-4 divide-y divide-line">
            {expenses.slice(0, 60).map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-sunken text-[18px]" aria-hidden="true">{cat(e.category).emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{e.note || cat(e.category).label}</span>
                  <span className="block text-[12px] text-muted">{name(e.paid_by)} จ่าย · หาร {e.split.length || members.length} คน</span>
                </span>
                <span className="font-semibold tnum">{baht(e.amount)}</span>
                <button onClick={() => del(e.id)} className={`grid h-9 min-w-9 place-items-center rounded-full px-2 text-[13px] font-semibold ${arm === e.id ? "bg-danger text-white" : "text-muted hover:bg-sunken hover:text-danger"}`}
                  aria-label={arm === e.id ? "แตะอีกครั้งเพื่อลบ" : `ลบรายการ ${e.note ?? ""}`}>{arm === e.id ? "ลบ?" : <IconTrash size={16} />}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function People({ label, members, me, picked, onPick }: { label: string; members: MemberT[]; me: string; picked: string[]; onPick: (id: string) => void }) {
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-medium text-muted">{label}</p>
      <div className="flex flex-wrap gap-2">
        {members.map((m) => {
          const on = picked.includes(m.id);
          return (
            <button key={m.id} type="button" aria-pressed={on} onClick={() => onPick(m.id)}
              className={`inline-flex h-10 items-center gap-1.5 rounded-full border pl-1 pr-3 text-[14px] ${on ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}>
              <img src={avatarDataUrl(m.id, m.color)} alt="" className="size-8 rounded-full" />{m.id === me ? "คุณ" : m.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

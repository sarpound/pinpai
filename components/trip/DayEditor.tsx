"use client";
// Edit mode for one day: drag to reorder, set times / lock / how long to stay, live re-timing preview,
// everything saved in one request when the person taps "บันทึก".
import { useEffect, useMemo, useRef, useState } from "react";
import type { Place } from "@/lib/types";
import { fmtDur, inkOn } from "@/lib/client/util";
import { retimeDay, legMinutes, km as kmBetween, toHHMM, toMin, dayStamp, optimizeOrder, betterSpot, type RStop, type RetimeCtx, type Warning } from "@/lib/retime";
import { IconX } from "@/components/icons";
import { CatIcon } from "./shared";
import { shortName } from "./DayViews";

export type DayEdit = { start_time?: string | null; duration_min?: number | null; fixed?: boolean; user_dur?: boolean };
const DURS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480];
const durLabel = (m: number) => (m === 360 ? "ครึ่งวัน" : m === 480 ? "ทั้งวัน" : m < 60 ? `${m} น.` : m % 60 ? `${Math.floor(m / 60)}.5 ชม.` : `${m / 60} ชม.`);
const WARN_ICON: Record<Warning["kind"], string> = { late: "⏰", leave: "✈️", meal: "🍜", overnight: "🌙", closed: "🚪" };

export type DayExtra = { drop: string[]; times: Record<string, { start_time: string | null; duration_min: number | null }> };

export default function DayEditor({ day, rows, color, ctx: ctx0, today, onSave, onCancel, onOrder }: {
  day: number;
  rows: Place[];                // every row of the day (hotels included), in saved order
  color: string;
  ctx: RetimeCtx;
  today?: boolean;              // this day is today → "เริ่มจากตอนนี้"
  onSave: (order: string[], edits: Record<string, DayEdit>, baseStamp: string, extra: DayExtra) => Promise<boolean>;
  onCancel: () => void;
  onOrder?: (ids: string[] | null) => void;   // live order for the map while editing
}) {
  // the version of the day this edit started from: saving fails loudly if a friend changed it meanwhile
  const [base] = useState(() => ({ stamp: dayStamp(rows), rows }));
  const stops0 = useMemo(() => base.rows.filter((r) => r.category !== "stay"), [base]);
  const [order, setOrder] = useState(() => stops0.map((r) => r.id));
  const [edits, setEdits] = useState<Record<string, DayEdit>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; kb: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [say, setSay] = useState("");
  const [drop, setDrop] = useState<string[]>([]);
  const [shift, setShift] = useState(0);                 // "เลื่อนทั้งวัน" in minutes
  const [fromNow, setFromNow] = useState<number | null>(null);
  const [opt, setOpt] = useState<{ saved: number; moved: number; prev: string[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const byId = useMemo(() => new Map(base.rows.map((r) => [r.id, r])), [base]);
  const listRef = useRef<HTMLOListElement>(null);
  const changedElsewhere = dayStamp(rows) !== base.stamp;

  const toStop = (id: string): RStop => {
    const r = byId.get(id)!, e = edits[id] ?? {};
    const has = (k: keyof DayEdit) => Object.prototype.hasOwnProperty.call(e, k);
    const st = has("start_time") ? e.start_time ?? null : r.start_time;
    return { id, name: r.name, category: r.category, lat: r.lat, lng: r.lng, start_time: st,
      duration_min: has("duration_min") ? e.duration_min ?? null : r.duration_min,
      fixed: has("fixed") ? !!e.fixed && st != null : !!r.details?.fixed_time && st != null,
      userDur: has("duration_min") ? e.duration_min != null : !!r.details?.user_dur, visited: r.visited };
  };
  const startOf = useMemo(() => {
    const t = stops0.map((r) => toMin(r.start_time)).filter((x): x is number => x != null);
    return t.length ? Math.min(...t) : 9 * 60;
  }, [stops0]);
  const ctx: RetimeCtx = { ...ctx0, ...(shift ? { dayStart: Math.max(5 * 60, startOf + shift) } : {}), ...(fromNow != null ? { notBefore: fromNow } : {}) };
  const plan = useMemo(() => retimeDay(order.map(toStop), ctx), [order, edits, shift, fromNow, ctx0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onOrder?.(order); }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onOrder?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const before = useMemo(() => retimeDay(stops0.map((r) => toStopOf(r)), ctx0), [stops0, ctx0]);
  const at = new Map(plan.stops.map((s) => [s.id, s]));
  const warnsOf = (id: string) => plan.warnings.filter((w) => w.id === id);
  const dirty = Object.keys(edits).length > 0 || drop.length > 0 || shift !== 0 || fromNow != null || order.join() !== stops0.map((r) => r.id).join();

  // ---------- one-tap fixes ----------
  const flash = (t: string) => { setNote(t); setSay(t); };
  function optimize() {
    const r = optimizeOrder(order.map(toStop), ctx);
    if (!r) return flash("เส้นทางนี้ดีอยู่แล้ว สลับแล้วไม่ประหยัดเวลาเพิ่ม");
    setOpt({ saved: r.saved, moved: r.moved, prev: order });
    setOrder(r.order);
    flash(`จัดใหม่ ประหยัด ${fmtDur(r.saved)} · เปลี่ยน ${r.moved} จุด`);
  }
  function toWishlist(id: string) {
    setDrop((d) => [...d, id]); setOrder((o) => o.filter((x) => x !== id)); setOpen(null);
    flash(`ย้าย ${byId.get(id)?.name} ไปรอจัด (บันทึกแล้วจะไปอยู่แท็บรอจัด)`);
  }
  function reposition(id: string) {
    const r = betterSpot(order.map(toStop), id, ctx);
    if (!r) return flash("วันนี้ไม่มีช่วงที่เหมาะกว่า ลองย้ายไปวันอื่นหรือไปรอจัด");
    setOrder(r.order);
    flash(`ย้าย ${byId.get(id)?.name} ไปช่วง ${r.start_time}`);
  }
  function fixesFor(w: Warning): { label: string; run: () => void }[] {
    const i = order.indexOf(w.id), prev = i > 0 ? order[i - 1] : null;
    if (w.kind === "late") return [
      ...(lockedOf(w.id) ? [{ label: "ปลดล็อกเวลานี้", run: () => edit(w.id, { fixed: false }) }] : []),
      ...(prev && !lockedOf(prev) ? [{ label: `เอา ${shortName(byId.get(prev)!.name)} ไปรอจัด`, run: () => toWishlist(prev) }] : []),
    ];
    if (w.kind === "closed" || w.kind === "meal") return [{ label: "หาช่วงที่เหมาะกว่า", run: () => reposition(w.id) }, { label: "ไปรอจัด", run: () => toWishlist(w.id) }];
    return [{ label: "ไปรอจัด", run: () => toWishlist(w.id) }];
  }
  const travelDiff = plan.travel_min - before.travel_min;

  const edit = (id: string, e: DayEdit) => setEdits((m) => ({ ...m, [id]: { ...m[id], ...e } }));
  const lockedOf = (id: string) => toStop(id).fixed;

  // ---------- drag with pointer (mouse, touch, pen) on the handle ----------
  const dragId = useRef<string | null>(null);
  const pointerY = useRef(0);
  const raf = useRef(0);
  function scroller(el: HTMLElement | null): HTMLElement | null {
    for (let p = el?.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
    return null;
  }
  function moveTo(y: number) {
    const id = dragId.current, ol = listRef.current;
    if (!id || !ol) return;
    const items = [...ol.querySelectorAll<HTMLElement>("[data-stop]")].filter((el) => el.dataset.stop !== id);
    let idx = items.findIndex((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (idx < 0) idx = items.length;
    setOrder((o) => {
      const rest = o.filter((x) => x !== id);
      const next = [...rest.slice(0, idx), id, ...rest.slice(idx)];
      return next.join() === o.join() ? o : next;
    });
  }
  function onHandleDown(e: React.PointerEvent, id: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    // listen on the window: React moves the dragged row in the DOM while reordering, which can drop pointer capture
    const pid = e.pointerId;
    const mv = (ev: PointerEvent) => { if (ev.pointerId !== pid || !dragId.current) return; ev.preventDefault(); pointerY.current = ev.clientY; moveTo(ev.clientY); };
    const up = (ev: PointerEvent) => { if (ev.pointerId !== pid) return; window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); onHandleUp(); };
    window.addEventListener("pointermove", mv, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    dragId.current = id; pointerY.current = e.clientY;
    setDrag({ id, kb: false }); setOpen(null);
    navigator.vibrate?.(8);
    const sc = scroller(listRef.current);
    const tick = () => {
      if (!dragId.current) return;
      if (sc) {
        const r = sc.getBoundingClientRect(), y = pointerY.current, edge = 64;
        const v = y < r.top + edge ? -Math.ceil((r.top + edge - y) / 6) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 6) : 0;
        if (v) { sc.scrollTop += v; moveTo(y); }
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }
  function onHandleUp() {
    if (!dragId.current) return;
    const id = dragId.current;
    dragId.current = null; cancelAnimationFrame(raf.current);
    setDrag(null);
    const n = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-stop]") ?? [])].findIndex((el) => el.dataset.stop === id) + 1;
    setSay(`วาง ${byId.get(id)?.name} เป็นจุดที่ ${n}`);
  }
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // ---------- keyboard: Space picks up, arrows move, Space/Enter/Escape drops ----------
  function onHandleKey(e: React.KeyboardEvent, id: string) {
    const name = byId.get(id)?.name ?? "";
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (drag?.id === id) { setDrag(null); setSay(`วาง ${name} เป็นจุดที่ ${order.indexOf(id) + 1}`); }
      else { setDrag({ id, kb: true }); setSay(`หยิบ ${name} แล้ว ใช้ลูกศรขึ้นลงเพื่อย้าย กด Space เพื่อวาง`); }
    } else if (e.key === "Escape" && drag?.id === id) {
      setDrag(null); setSay(`วาง ${name}`);
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && drag?.id === id) {
      e.preventDefault();
      const i = order.indexOf(id), j = i + (e.key === "ArrowUp" ? -1 : 1);
      if (j < 0 || j >= order.length) return;
      const next = [...order]; [next[i], next[j]] = [next[j], next[i]];
      setOrder(next); setSay(`${name} อยู่ที่ ${j + 1} จาก ${order.length}`);
      requestAnimationFrame(() => (document.querySelector(`[data-handle="${id}"]`) as HTMLElement | null)?.focus());
    }
  }

  async function save() {
    // hotels keep their own slots; the stops fill the rest in the new order
    let k = 0;
    const full = base.rows.filter((r) => !drop.includes(r.id)).map((r) => (r.category === "stay" ? r.id : order[k++]));
    // save exactly the preview: same engine, plus the day shift / "from now" only the editor knows about
    const times = Object.fromEntries(plan.stops.map((x) => [x.id, { start_time: x.start_time, duration_min: x.duration_min }]));
    setSaving(true);
    const ok = await onSave(full, edits, base.stamp, { drop, times });
    setSaving(false);
    if (ok) onCancel();
  }

  return (
    <div className="pb-28">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold leading-[26px]">แก้แผนวันที่ {day + 1}</h2>
          <p className="text-[12px] text-muted">ลาก ≡ เพื่อเรียงใหม่ · แตะเวลาเพื่อตั้งเวลา · เวลาจุดอื่นคำนวณให้ทันที</p>
        </div>
        <button onClick={onCancel} aria-label="ปิดโหมดแก้ไข" className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-sunken"><IconX size={18} /></button>
      </div>

      {changedElsewhere && (
        <p className="mt-3 rounded-[14px] bg-[#FFF4D6] px-3 py-2 text-[13px]" role="status">มีเพื่อนเพิ่งแก้วันนี้ ถ้าบันทึกตอนนี้ระบบจะให้โหลดของล่าสุดก่อน</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5" role="toolbar" aria-label="เครื่องมือจัดวัน">
        <button type="button" onClick={optimize} className="h-9 rounded-full bg-ink px-3 text-[13px] font-semibold text-white">⚡ จัดเส้นทางให้สั้นลง</button>
        <button type="button" onClick={() => setShift((x) => x - 30)} className="h-9 rounded-full border border-line px-3 text-[13px] tnum" aria-label="เลื่อนทั้งวันเร็วขึ้น 30 นาที">−30 นาที</button>
        <button type="button" onClick={() => setShift((x) => x + 30)} className="h-9 rounded-full border border-line px-3 text-[13px] tnum" aria-label="เลื่อนทั้งวันช้าลง 30 นาที">+30 นาที</button>
        {today && (
          <button type="button" aria-pressed={fromNow != null} onClick={() => { const n = new Date(); setFromNow(fromNow != null ? null : n.getHours() * 60 + n.getMinutes()); }}
            className={`h-9 rounded-full border px-3 text-[13px] ${fromNow != null ? "border-ink bg-ink text-white" : "border-line"}`}>▶ เริ่มจากตอนนี้</button>
        )}
      </div>
      {(shift !== 0 || note || opt) && (
        <div className="mt-2 flex items-center gap-2 rounded-[14px] bg-sunken px-3 py-2 text-[13px]" role="status">
          <span className="min-w-0 flex-1">{note ?? ""}{shift !== 0 ? `${note ? " · " : ""}เลื่อนทั้งวัน ${shift > 0 ? "+" : "−"}${fmtDur(Math.abs(shift))} (จุดที่ล็อกไม่ขยับ)` : ""}</span>
          {opt && <button type="button" onClick={() => { setOrder(opt.prev); setOpt(null); setNote(null); }} className="h-8 shrink-0 rounded-full px-2 font-semibold text-accent">ย้อน</button>}
          {shift !== 0 && <button type="button" onClick={() => setShift(0)} className="h-8 shrink-0 rounded-full px-2 font-semibold text-accent">รีเซ็ต</button>}
        </div>
      )}

      <ol ref={listRef} className="mt-3" aria-label={`ลำดับที่เที่ยววันที่ ${day + 1}`}>
        {order.map((id, i) => {
          const r = byId.get(id)!, s = at.get(id), w = warnsOf(id), locked = lockedOf(id);
          const dur = s?.duration_min ?? r.duration_min ?? 60;
          const dragging = drag?.id === id;
          const prev = i > 0 ? byId.get(order[i - 1])! : null;
          return (
            <li key={id} data-stop={id}>
              {prev && (
                <div className="flex h-7 items-center gap-2 pl-[22px] text-[12px] text-muted tnum" aria-hidden>
                  <span className="h-full w-0 border-l-2 border-dotted" style={{ borderColor: color }} />
                  <span className="ml-3">{prev.lat == null || r.lat == null || prev.lng == null || r.lng == null ? "~15 นาที" : (() => {
                    const d = ctx.calib?.detour ? Math.min(1.6, Math.max(1.15, ctx.calib.detour)) : 1.3;
                    const road = kmBetween({ lat: prev.lat, lng: prev.lng }, { lat: r.lat, lng: r.lng }) * d;
                    const l = legMinutes(road, null, ctx.mode, ctx.calib);
                    return `${l.kind === "walk" ? "🚶 เดิน" : l.kind === "transit" ? "🚇 รถไฟฟ้า/รถเมล์" : "🚕 รถ"} ${l.min} นาที · ${road < 1 ? `${Math.round(road * 100) * 10} ม.` : `${road.toFixed(1)} กม.`}`;
                  })()}</span>
                </div>
              )}
              <div className={`rounded-[16px] border bg-surface transition-shadow ${dragging ? "relative z-10 border-ink shadow-[var(--shadow-2)]" : w.length ? "border-[#E9B949]" : "border-line"}`}>
                <div className="flex items-center gap-2 p-1.5 pr-2">
                  <button type="button" data-handle={id}
                    onPointerDown={(e) => onHandleDown(e, id)}
                    onKeyDown={(e) => onHandleKey(e, id)} aria-pressed={dragging}
                    aria-label={`ย้าย ${r.name} (จุดที่ ${i + 1}) กด Space แล้วใช้ลูกศร`}
                    className="grid h-12 w-9 shrink-0 cursor-grab touch-none place-items-center rounded-[10px] text-muted hover:bg-sunken active:cursor-grabbing">
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  </button>
                  <span className={`grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold tnum ${inkOn(color) ? "text-ink" : "text-white"}`} style={{ background: color }}>{i + 1}</span>
                  <button type="button" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[15px] font-semibold leading-6"><span className="mr-1 inline-block align-[-2px] text-muted"><CatIcon category={r.category} size={14} /></span>{shortName(r.name)}</span>
                    <span className="block text-[12px] text-muted tnum">
                      {s?.start_time ?? "--:--"}–{s ? toHHMM((Number(s.start_time!.slice(0, 2)) * 60 + Number(s.start_time!.slice(3, 5)) + dur)) : "--:--"} · {fmtDur(dur)}{locked ? " · 🔒" : ""}
                    </span>
                  </button>
                </div>
                {w.length > 0 && (
                  <ul className="space-y-1.5 px-3 pb-2.5 text-[12px] font-medium text-[#8A5A00]">
                    {w.map((x, k) => (
                      <li key={k}>
                        <span>{WARN_ICON[x.kind]} {x.msg}</span>
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          {fixesFor(x).map((f) => (
                            <button key={f.label} type="button" onClick={f.run} className="h-8 rounded-full bg-[#FFF4D6] px-3 text-[12px] font-semibold text-ink hover:bg-[#FBE7B0]">{f.label}</button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {open === id && (
                  <div className="space-y-3 border-t border-line px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <label htmlFor={`t-${id}`} className="w-16 text-[13px] font-medium">เริ่ม</label>
                      <input id={`t-${id}`} type="time" defaultValue={s?.start_time ?? ""} key={`${id}-${s?.start_time}`}
                        onBlur={(e) => { const v = e.target.value; if (v && v !== s?.start_time) edit(id, { start_time: v, fixed: true }); }}
                        className="h-10 rounded-full border border-line bg-surface px-2 text-[16px] tnum" />
                      <button type="button" aria-pressed={locked}
                        onClick={() => edit(id, locked ? { fixed: false } : { start_time: s?.start_time ?? null, fixed: true })}
                        className={`h-10 rounded-full border px-3 text-[13px] font-medium ${locked ? "border-ink bg-ink text-white" : "border-line"}`}>
                        {locked ? "🔒 ล็อกเวลา" : "ล็อกเวลานี้"}
                      </button>
                    </div>
                    <p className="-mt-1 text-[12px] text-muted">{locked ? "เวลานี้ไม่ขยับ จุดอื่นจะจัดรอบๆ (เช่น จองร้าน รอบโชว์)" : "ไม่ล็อก = เวลาไหลตามจุดก่อนหน้า"}</p>
                    <div>
                      <p className="mb-1.5 text-[13px] font-medium">อยู่นานแค่ไหน</p>
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="ระยะเวลา">
                        {DURS.map((m) => (
                          <button key={m} type="button" aria-pressed={dur === m} onClick={() => edit(id, { duration_min: m })}
                            className={`h-9 rounded-full border px-3 text-[13px] tnum ${dur === m ? "border-ink bg-ink text-white" : "border-line hover:bg-sunken"}`}>{durLabel(m)}</button>
                        ))}
                      </div>
                    </div>
                    <button type="button" onClick={() => toWishlist(id)} className="h-9 rounded-full px-1 text-[13px] font-medium text-danger">เอาออกจากวันนี้ (ไปรอจัด)</button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="assertive">{say}</p>
      {drop.length > 0 && (
        <div className="mt-3 rounded-[14px] border border-dashed border-line p-3">
          <p className="text-[13px] font-medium">จะย้ายไปรอจัด</p>
          <ul className="mt-1.5 space-y-1">
            {drop.map((id) => (
              <li key={id} className="flex items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{byId.get(id)?.name}</span>
                <button type="button" onClick={() => { setDrop((d) => d.filter((x) => x !== id)); setOrder((o) => [...o, id]); }} className="h-8 shrink-0 rounded-full px-2 font-semibold text-accent">คืน</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="sticky -mx-4 mt-4 border-t border-line bg-surface px-4 pt-3" style={{ bottom: "calc(-1 * max(16px, env(safe-area-inset-bottom)))", paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
        <p className="text-[13px] text-muted tnum" aria-live="polite">
          เดินทางรวม {fmtDur(plan.travel_min)}{travelDiff ? <span className={travelDiff > 0 ? "text-danger" : "text-success"}> ({travelDiff > 0 ? "+" : "−"}{fmtDur(Math.abs(travelDiff))})</span> : null}
          {plan.end_min != null ? ` · จบวัน ${toHHMM(plan.end_min)}${plan.end_min >= 1440 ? " (+1)" : ""}` : ""}
          {plan.warnings.length ? <span className="text-[#8A5A00]"> · ⚠️ {plan.warnings.length} จุด</span> : null}
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={onCancel} className="h-11 flex-1 rounded-full border border-line text-[15px] font-medium">ยกเลิก</button>
          <button type="button" disabled={!dirty || saving} onClick={save} className="h-11 flex-[2] rounded-full bg-ink text-[15px] font-semibold text-white disabled:opacity-40">
            {saving ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </div>
      </div>
    </div>
  );

  function toStopOf(r: Place): RStop {
    return { id: r.id, name: r.name, category: r.category, lat: r.lat, lng: r.lng, start_time: r.start_time, duration_min: r.duration_min,
      fixed: (!!r.details?.fixed_time || !!r.details?.sun_time) && r.start_time != null, userDur: !!r.details?.user_dur, visited: r.visited };
  }
}

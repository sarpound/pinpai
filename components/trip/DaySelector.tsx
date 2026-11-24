"use client";
import { useState } from "react";
import { inkOn } from "@/lib/client/util";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconHeart, IconMap } from "@/components/icons";

type Day = { index: number; color: string; short: string; num: number; month: string };
type Tab = "wish" | "all" | number;

/**
 * No hidden horizontal scrolling: up to 7 days are all visible as equal cells;
 * longer trips get explicit ‹ › buttons plus an "all days" grid that wraps.
 */
export default function DaySelector({ days, tab, counts, wishCount, onChange }: {
  days: Day[]; tab: Tab; counts: Map<number, number>; wishCount: number; onChange: (t: Tab) => void;
}) {
  const [open, setOpen] = useState(false);
  const compact = days.length <= 7;
  const cur = typeof tab === "number" ? days[tab] : null;

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const AllCell = days.length > 1 && total > 0 ? (
    <button onClick={() => { onChange("all"); setOpen(false); }} aria-pressed={tab === "all"}
      className={`flex h-14 shrink-0 flex-col items-center justify-center rounded-[14px] px-2 transition-colors ${tab === "all" ? "bg-ink text-white" : "bg-sunken text-ink hover:bg-line/60"}`}>
      <span className="text-[11px] leading-4 opacity-80">ทั้งทริป</span>
      <span className="flex h-6 items-center"><IconMap size={16} /></span>
      <span className="sr-only">ดูทุกวันรวมกัน</span>
    </button>
  ) : null;
  const WishCell = (
    <button onClick={() => { onChange("wish"); setOpen(false); }} aria-pressed={tab === "wish"}
      className={`flex h-14 shrink-0 flex-col items-center justify-center rounded-[14px] px-2 transition-colors ${tab === "wish" ? "bg-ink text-white" : "bg-sunken text-ink hover:bg-line/60"}`}>
      <span className="text-[11px] leading-4 opacity-80">รอจัด</span>
      <span className="flex items-center gap-1 text-[15px] font-semibold leading-6 tnum"><IconHeart size={13} filled={tab === "wish"} />{wishCount}</span>
      <span className="sr-only">ยังไม่ลงวัน</span>
    </button>
  );

  const DayCell = ({ d, big }: { d: Day; big?: boolean }) => {
    const on = tab === d.index;
    const n = counts.get(d.index) ?? 0;
    return (
      <button onClick={() => { onChange(d.index); setOpen(false); }} aria-pressed={on} aria-label={`วันที่ ${d.index + 1} ${d.short} ${d.num} ${d.month} ${n} ที่`}
        className={`relative flex h-14 min-w-0 flex-col items-center justify-center rounded-[14px] transition-colors ${on ? "bg-ink text-white" : "text-ink hover:bg-sunken"} ${big ? "" : ""}`}>
        <span className={`text-[11px] leading-4 ${on ? "text-white/70" : "text-muted"}`}>{d.short}</span>
        <span className="font-display text-[17px] font-semibold leading-6 tnum">{d.num}</span>
        <span className="absolute bottom-1.5 h-1 w-4 rounded-full" style={{ background: n ? d.color : on ? "rgb(255 255 255 / .25)" : "var(--color-line)" }} />
      </button>
    );
  };

  if (!days.length) {
    return <div className="flex px-4 pb-3">{WishCell}<p className="ml-3 self-center text-[12px] text-muted">ตั้งวันไป–กลับ เพื่อจัดแผนรายวัน</p></div>;
  }

  if (compact) {
    return (
      <div className="flex gap-1.5 px-4 pb-3" role="group" aria-label="เลือกวัน">
        {AllCell}
        {WishCell}
        <div className="grid min-w-0 flex-1 gap-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d) => <DayCell key={d.index} d={d} />)}
        </div>
      </div>
    );
  }

  const i = typeof tab === "number" ? tab : -1;
  return (
    <div className="px-4 pb-3" role="group" aria-label="เลือกวัน">
      <div className="flex items-center gap-1.5">
        {AllCell}
        {WishCell}
        <button onClick={() => onChange(i <= 0 ? "wish" : i - 1)} disabled={typeof tab !== "number"} aria-label="วันก่อนหน้า"
          className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface disabled:opacity-40"><IconChevronLeft size={18} /></button>
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex h-14 min-w-0 flex-1 items-center justify-center gap-2 rounded-[14px] bg-sunken px-3 hover:bg-line/60">
          {cur ? (
            <>
              <span className={`grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${inkOn(cur.color) ? "text-ink" : "text-white"}`} style={{ background: cur.color }}>{cur.index + 1}</span>
              <span className="min-w-0 truncate text-[15px] font-semibold">{cur.short} {cur.num} {cur.month}</span>
              <span className="shrink-0 text-[12px] text-muted tnum">{cur.index + 1}/{days.length}</span>
            </>
          ) : <span className="text-[15px] font-semibold">เลือกวัน · {days.length} วัน</span>}
          <IconChevronDown size={16} />
        </button>
        <button onClick={() => onChange(Math.min(days.length - 1, i + 1))} disabled={i >= days.length - 1} aria-label="วันถัดไป"
          className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface disabled:opacity-40"><IconChevronRight size={18} /></button>
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-7 gap-1 rounded-[16px] border border-line bg-surface p-1.5 shadow-[var(--shadow-1)]">
          {days.map((d) => <DayCell key={d.index} d={d} />)}
        </div>
      )}
    </div>
  );
}

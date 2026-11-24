"use client";
import { CATEGORY, inkOn } from "@/lib/client/util";
import { IconCheck } from "@/components/icons";
import type { Candidate } from "@/lib/types";

export function PinBadge({ color, label, size = 28 }: { color: string; label: string | number; size?: number }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-full border-2 border-white text-[11px] font-semibold shadow-[var(--shadow-1)] tnum ${inkOn(color) ? "text-ink" : "text-white"}`}
      style={{ background: color, width: size, height: size }}>{label}</span>
  );
}

export function CatIcon({ category, size = 16 }: { category: string; size?: number }) {
  const C = (CATEGORY[category] ?? CATEGORY.other).Icon;
  return <C size={size} />;
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-[17px] font-semibold leading-[26px]">{children}</h3>
      {action}
    </div>
  );
}

/** Review list for AI-detected candidates (video import / recommendations). */
export function CandidateList({ items, picked, onToggle }: { items: Candidate[]; picked: Set<number>; onToggle: (i: number) => void }) {
  return (
    <ul className="divide-y divide-line rounded-[16px] border border-line bg-surface">
      {items.map((c, i) => {
        const on = picked.has(i);
        return (
          <li key={i}>
            <button type="button" onClick={() => onToggle(i)} aria-pressed={on} className="flex w-full items-start gap-3 px-3.5 py-3 text-left hover:bg-sunken">
              <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-[6px] border ${on ? "border-accent bg-accent text-white" : "border-line bg-surface"}`}>
                {on && <IconCheck size={14} />}
              </span>
              {c.photo?.url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.photo.url} alt="" loading="lazy" className="size-14 shrink-0 rounded-[12px] object-cover" />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 font-semibold leading-6">
                  <span className="text-muted"><CatIcon category={c.category} size={15} /></span>
                  <span className="truncate">{c.name}</span>
                </span>
                <span className="block text-[14px] leading-[22px] text-muted">{c.why}</span>
                {c.duplicate && <span className="mt-0.5 mr-1.5 inline-block rounded-full bg-sunken px-2 py-0.5 text-[12px] font-medium text-ink">มีในทริปแล้ว</span>}
                {c.far_km != null && <span className="mt-0.5 inline-block rounded-full bg-[#FFF4D6] px-2 py-0.5 text-[12px] font-medium text-ink">ไกลจากจุดหมาย ~{c.far_km.toLocaleString("en-US")} กม.</span>}
                {c.lat == null ? (
                  <span className="mt-0.5 block text-[12px] text-danger">ยังหาพิกัดไม่เจอ จะเพิ่มแบบไม่มีหมุด</span>
                ) : c.approx ? (
                  <span className="mt-0.5 block text-[12px] text-muted">พิกัดโดยประมาณ ตรวจหมุดอีกทีก่อนไป</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

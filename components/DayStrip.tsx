import { dayList, inkOn } from "@/lib/client/util";

/** The trip as a transit line: one station per day, coloured by its Thai weekday colour. */
export default function DayStrip({ start, end, compact = false }: { start: string | null; end: string | null; compact?: boolean }) {
  const days = dayList(start, end);
  if (!days.length) return null;
  return (
    <div aria-label="วันในทริป">
      <ol className="flex flex-wrap items-start gap-y-2">
        {days.map((d, i) => (
          <li key={i} className="flex items-start">
            <div className="flex w-11 flex-col items-center">
              <span className={`grid size-7 place-items-center rounded-full border-2 border-white text-[11px] font-semibold shadow-[var(--shadow-1)] ${inkOn(d.color) ? "text-ink" : "text-white"}`} style={{ background: d.color }}>{i + 1}</span>
              {!compact && <span className="mt-1 text-[11px] leading-4 text-muted">{d.short} {d.num}</span>}
            </div>
            {i < days.length - 1 && <span className="mt-[13px] h-[3px] w-5 rounded-full" style={{ background: `linear-gradient(90deg, ${d.color}, ${days[i + 1].color})` }} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

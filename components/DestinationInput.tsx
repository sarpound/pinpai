"use client";
import { useEffect, useRef, useState } from "react";
import { inputCls } from "@/components/ui/Field";
import { IconPin } from "@/components/icons";

type Hit = { name: string; lat: number; lng: number; address: string };
export type Dest = { name: string; lat: number | null; lng: number | null };

/** Destination box with city/province/country suggestions as you type. */
export default function DestinationInput({ id, value, onChange, placeholder }: {
  id: string; value: Dest; onChange: (d: Dest) => void; placeholder?: string;
}) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const picked = useRef<string | null>(null);

  useEffect(() => {
    const q = value.name.trim();
    if (q.length < 2 || picked.current === q) { setHits([]); setLoading(false); return; }
    const t = setTimeout(async () => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      try {
        const r = await fetch(`/api/search?type=dest&q=${encodeURIComponent(q)}`, { signal: c.signal });
        const j = (await r.json()) as { results?: Hit[] };
        if (!c.signal.aborted) { setHits(j.results ?? []); setActive(0); setOpen(true); }
      } catch {} finally { if (!c.signal.aborted) setLoading(false); }
    }, 400);
    return () => clearTimeout(t);
  }, [value.name]);

  function pick(h: Hit) {
    picked.current = h.name;
    onChange({ name: h.name, lat: h.lat, lng: h.lng });
    setOpen(false);
    setHits([]);
  }

  const show = open && hits.length > 0;
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"><IconPin size={18} /></span>
      <input id={id} value={value.name} autoComplete="off" placeholder={placeholder} enterKeyHint="next"
        role="combobox" aria-expanded={show} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={show ? `${id}-opt-${active}` : undefined}
        className={`${inputCls} pl-10`}
        onChange={(e) => { picked.current = null; onChange({ name: e.target.value, lat: null, lng: null }); }}
        onFocus={() => hits.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
          else if (e.key === "Enter") { e.preventDefault(); pick(hits[active]); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {loading && <span className="absolute right-3.5 top-1/2 size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden />}
      {show && (
        <ul id={`${id}-list`} role="listbox" className="absolute inset-x-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-[16px] border border-line bg-surface shadow-[var(--shadow-2)]">
          {hits.map((h, i) => (
            <li key={`${h.name}-${h.lat}`} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)} onMouseEnter={() => setActive(i)}
                className={`flex min-h-12 w-full items-center gap-3 px-3.5 py-2 text-left ${i === active ? "bg-sunken" : ""}`}>
                <span className="text-muted"><IconPin size={16} /></span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold leading-6">{h.name}</span>
                  {h.address && <span className="block truncate text-[12px] leading-[18px] text-muted">{h.address}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

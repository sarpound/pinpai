"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Input, Label, inputCls, Button } from "@/components/ui/Field";
import { IconSearch, IconWand } from "@/components/icons";
import { CATEGORY, distKm, fmtKm } from "@/lib/client/util";
import { CatIcon } from "./shared";
import type { Slot, Warning } from "@/lib/retime";

/** a ranked spot in a day plus what to send to the API to put the new stop there */
export type SlotPick = Slot & { body: { after_id?: string; sort_order?: number } };

type Hit = { name: string; lat: number; lng: number; address: string; kind?: string; category?: string; approx?: boolean; why?: string };
type Res = { results: Hit[]; source: string; degraded?: boolean };

function shortAddress(a: string) {
  // drop country, keep the 2 most specific parts
  return a.split(",").map((s) => s.trim()).filter(Boolean).slice(0, -1).slice(-3, -1).join(", ") || a;
}

export default function AddPanel({ tripId, token, near, dayOptions, defaultDay, onPreview, onDone, slotsFor }: {
  tripId: string; token: string; near: { lat: number; lng: number } | null;
  dayOptions: { value: number | null; label: string }[]; defaultDay: number | null;
  onPreview: (h: { name: string; lat: number; lng: number }[]) => void; onDone: (msg: string) => void;
  /** best places in a day for a new stop (empty = the day has no stops yet) */
  slotsFor?: (day: number, cand: { name: string; category: string; lat: number; lng: number }) => SlotPick[];
}) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Res | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [day, setDay] = useState<number | null>(defaultDay);
  const [category, setCategory] = useState("attraction");
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pick, setPick] = useState<{ h: Hit; slots: SlotPick[] } | null>(null);
  const catOf = (h: Hit) => (h.category && h.category !== "other" ? h.category : "attraction");
  const ctrl = useRef<AbortController | null>(null);
  // round the bias point so identical searches share the edge cache
  const bias = near ? `&lat=${near.lat.toFixed(2)}&lng=${near.lng.toFixed(2)}` : "";

  async function search(text: string, deep = false) {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(text.trim())}${bias}${deep ? "&deep=1" : ""}&trip=${tripId}`, { signal: c.signal, headers: { "x-pp-token": token } });
      const j = (await r.json()) as Res & { error?: string };
      if (c.signal.aborted) return;
      if (!r.ok) throw new Error(j.error ?? "ค้นหาไม่สำเร็จ");
      setRes(j);
      setActive(0);
      onPreview(j.results);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (q.trim().length < 2) { ctrl.current?.abort(); setRes(null); setLoading(false); onPreview([]); return; }
    const t = setTimeout(() => search(q), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function askAi() {
    setAiBusy(true);
    setErr(null);
    try {
      const r = await api<Res>(`/api/trips/${tripId}/search-ai`, { token, body: { q } });
      setRes(r);
      onPreview(r.results);
      if (!r.results.length) setErr("AI ก็ยังหาไม่เจอ ลองพิมพ์ชื่อภาษาอังกฤษ หรือเพิ่มเป็นชื่ออย่างเดียวไว้ก่อน");
    } catch (e) { setErr((e as Error).message); } finally { setAiBusy(false); }
  }

  /** tapping a result for a day that already has stops → choose where it goes first */
  function choose(h: Hit) {
    if (day == null || !slotsFor) return add(h);
    const slots = slotsFor(day, { name: h.name, category: catOf(h), lat: h.lat, lng: h.lng });
    if (!slots.length) return add(h);
    setPick({ h, slots });
    onPreview([h]);
  }

  async function add(h: Hit | null, slot?: SlotPick | "end" | "later") {
    setErr(null);
    try {
      const where = slot && typeof slot === "object" ? { ...slot.body, retime: true } : slot === "end" ? { retime: true } : {};
      const r = await api<{ id: string; warnings?: Warning[] }>(`/api/trips/${tripId}/places`, { token, body: h
        ? { name: h.name, lat: h.lat, lng: h.lng, address: h.address, category: catOf(h), day_index: day, source: h.why ? "ai" : "search", details: h.why ? { why: h.why } : undefined, ...where }
        : { name: q.trim(), category, day_index: day } });
      onPreview([]);
      const name = h?.name ?? q.trim();
      const warn = r.warnings?.find((w) => w.kind === "late" || w.kind === "leave");
      onDone(slot && typeof slot === "object"
        ? `เพิ่ม ${name} ${slot.after_name ? `หลัง ${slot.after_name}` : "เป็นที่แรกของวัน"} · เริ่ม ${slot.start_time}${warn ? ` · ⚠️ ${warn.msg}` : ""}`
        : `เพิ่ม ${name} แล้ว ค้นหาที่ต่อไปได้เลย`);
      setQ("");
      setRes(null);
      setPick(null);
    } catch (e) { setErr((e as Error).message); }
  }

  function onKey(e: React.KeyboardEvent) {
    const n = res?.results.length ?? 0;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); setActive((a) => (a + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); setActive((a) => (a - 1 + n) % n); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (n) choose(res!.results[active]);
      else if (q.trim().length >= 2) search(q, true); // explicit search: also try Nominatim
    }
  }

  const hits = res?.results ?? [];
  const translated = (res as (Res & { translated?: string[] }) | null)?.translated;
  const typed = q.trim().length >= 2;

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="add-q">ค้นหาสถานที่</Label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"><IconSearch size={18} /></span>
          <Input id="add-q" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="ชื่อร้าน วัด จุดชมวิว ห้าง…" className="pl-10"
            autoFocus autoComplete="off" enterKeyHint="search" role="combobox" aria-expanded={hits.length > 0} aria-controls="add-results"
            aria-activedescendant={hits.length ? `add-opt-${active}` : undefined} />
        </div>
      </div>
      <div>
        <Label htmlFor="add-day">ใส่ไว้ที่</Label>
        <select id="add-day" value={day ?? ""} onChange={(e) => setDay(e.target.value === "" ? null : Number(e.target.value))} className={inputCls}>
          {dayOptions.map((o) => <option key={String(o.value)} value={o.value ?? ""}>{o.label}</option>)}
        </select>
      </div>

      {pick && (
        <div className="rounded-[16px] border border-line bg-surface p-3.5" role="group" aria-labelledby="slot-h">
          <p id="slot-h" className="text-[15px] font-semibold leading-6">ใส่ {pick.h.name} ตรงไหนดี</p>
          <p className="text-[12px] text-muted">เรียงจากที่เสียเวลาเดินทางเพิ่มน้อยสุด จุดหลังจากนั้นจะขยับเวลาตาม</p>
          <ul className="mt-2.5 space-y-2">
            {pick.slots.map((sl, i) => (
              <li key={sl.index}>
                <button onClick={() => add(pick.h, sl)} className={`w-full rounded-[14px] border px-3 py-2.5 text-left hover:bg-sunken ${i === 0 ? "border-ink" : "border-line"}`}>
                  <span className="flex items-center gap-2 text-[14px] font-semibold">
                    <span className="min-w-0 flex-1 truncate">{sl.after_name ? `หลัง ${sl.after_name}` : `ก่อน ${sl.before_name ?? "ทุกที่"}`}</span>
                    {i === 0 && <span className="shrink-0 rounded-full bg-lime px-2 py-0.5 text-[11px] text-ink">แนะนำ</span>}
                  </span>
                  <span className="block text-[12px] text-muted tnum">
                    เริ่ม {sl.start_time} · เดินทางเพิ่ม {sl.added_min <= 0 ? "แทบไม่เพิ่ม" : `${sl.added_min} นาที`}{sl.end_shift >= 15 ? ` · จบวันช้าลง ${sl.end_shift} นาที` : ""}
                  </span>
                  {sl.warnings.length > 0 && <span className="block text-[12px] font-medium text-[#8A5A00]">⚠️ {sl.warnings[0].msg}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="chip" variant="secondary" onClick={() => add(pick.h, "end")}>ท้ายวัน</Button>
            <Button size="chip" variant="secondary" onClick={() => add(pick.h, "later")}>ใส่ไว้ก่อน ยังไม่ลงเวลา</Button>
            <Button size="chip" variant="ghost" onClick={() => { setPick(null); onPreview(hits); }}>ย้อนกลับ</Button>
          </div>
        </div>
      )}

      {!pick && (loading || aiBusy) && hits.length === 0 && <div className="space-y-2" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14" />)}</div>}

      {translated && translated.length > 0 && hits.length > 0 && <p className="text-[12px] text-muted">ค้นหาเป็น “{translated.join(" / ")}” ให้แล้ว</p>}
      {!pick && hits.length > 0 && (
        <ul id="add-results" role="listbox" aria-label="ผลการค้นหา" className={`divide-y divide-line rounded-[16px] border border-line bg-surface transition-opacity ${loading ? "opacity-60" : ""}`}>
          {hits.map((h, i) => {
            const cat = CATEGORY[h.category ?? "other"] ?? CATEGORY.other;
            return (
              <li key={`${h.name}-${h.lat}`} id={`add-opt-${i}`} role="option" aria-selected={i === active}>
                <button onClick={() => choose(h)} onMouseEnter={() => setActive(i)}
                  className={`flex min-h-14 w-full items-center gap-3 px-3.5 py-2.5 text-left ${i === active ? "bg-sunken" : ""}`}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-tint text-accent"><CatIcon category={h.category ?? "other"} size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold leading-6">{h.name}</span>
                    <span className="block truncate text-[12px] leading-[18px] text-muted">
                      {h.category && h.category !== "other" ? `${cat.label} · ` : ""}{h.why ?? shortAddress(h.address)}{h.approx ? " · พิกัดโดยประมาณ" : ""}
                    </span>
                  </span>
                  {near && <span className="shrink-0 text-[12px] text-muted tnum">{fmtKm(distKm(near, h))}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {typed && !loading && !aiBusy && res && (
        <div className="space-y-3 rounded-[16px] border border-dashed border-line p-3.5">
          <div>
            <p className="text-[14px] text-muted">{hits.length ? "ไม่ใช่ที่ต้องการ?" : res.degraded ? "ระบบค้นหาแผนที่ตอบช้า ลองอีกครั้ง หรือให้ AI ช่วยหา" : `ไม่เจอ “${q.trim().slice(0, 30)}” บนแผนที่`} ร้านเล็ก ชื่อเล่น หรือชื่อทับศัพท์ ให้ AI ช่วยหาได้</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={askAi} disabled={aiBusy}><IconWand size={16} />ให้ AI ช่วยหา</Button>
          </div>
          <div className="border-t border-line pt-3">
            <p className="text-[14px] text-muted">หรือเพิ่มเป็นชื่ออย่างเดียวไว้ก่อน แล้วค่อยปักหมุดทีหลัง</p>
            <div className="mt-2 flex gap-2">
              <select aria-label="หมวด" value={category} onChange={(e) => setCategory(e.target.value)} className="h-10 rounded-full border border-line bg-surface px-2 text-[16px]">
                {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <Button size="sm" variant="secondary" className="min-w-0" onClick={() => add(null)}><span className="truncate">เพิ่ม “{q.trim().slice(0, 18)}”</span></Button>
            </div>
          </div>
        </div>
      )}
      {aiBusy && <p className="text-[14px] text-muted" role="status">AI กำลังหาให้…</p>}
      {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}
      <p className="text-[12px] text-muted">ข้อมูลแผนที่ © ผู้ร่วมพัฒนา OpenStreetMap</p>
    </div>
  );
}

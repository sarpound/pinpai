"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { CATEGORY, fmtDur, gmapsPlace, inMainlandChina } from "@/lib/client/util";
import { Button, inputCls } from "@/components/ui/Field";
import { IconArrowDown, IconArrowUp, IconChevronLeft, IconChevronRight, IconExternal, IconHeart, IconTrash, IconRoute } from "@/components/icons";
import { CatIcon } from "./shared";
import type { Leg, MemberT, Place } from "@/lib/types";
import { NearHere, type PickFn } from "./Suggest";

export default function PlaceDetail({ place, tripId, token, me, members, dayOptions, destination, onChanged, onDeleted, onMove, onTime, onInfo, onSuggest, seq, onGo, onShare }: {
  place: Place; tripId: string; token: string; me: string; members: MemberT[];
  dayOptions: { value: number | null; label: string }[]; destination: string | null; onSuggest?: PickFn;
  onChanged: () => void; onDeleted: () => void; onMove: (dir: -1 | 1) => void; onTime: (time: string | null, lock: boolean) => void; onInfo?: (msg: string) => void;
  onShare?: () => void;
  seq?: { day: number; n: number; total: number; prev: Place | null; next: Place | null; legNext?: Leg; color: string } | null; onGo?: (id: string) => void;
}) {
  const d = place.details ?? {};
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState(place.notes ?? "");
  const tried = useRef<string | null>(null);
  const voted = place.votes.includes(me);
  const adder = members.find((m) => m.id === place.added_by);
  const cityHint = place.address?.split(",").slice(-3, -1).join(" ") || destination;

  useEffect(() => { setNotes(place.notes ?? ""); }, [place.id, place.notes]);
  // ‹ › between stops: start each place from its top
  const top = useRef<HTMLElement>(null);
  useEffect(() => { top.current?.scrollIntoView({ block: "start" }); }, [place.id]);

  useEffect(() => {
    if (d.summary || tried.current === place.id) return;
    tried.current = place.id;
    setLoading(true); setErr(null);
    api(`/api/trips/${tripId}/places/${place.id}/enrich`, { token, body: {} })
      .then(onChanged)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.id]);

  async function patch(body: Record<string, unknown>) {
    try {
      const r = await api<{ placed?: { day: number; after: string | null; at: string | null } | null }>(`/api/trips/${tripId}/places/${place.id}`, { token, method: "PATCH", body });
      // moved to another day: say where it landed (the server picks the spot with the least extra travel)
      if (r.placed) onInfo?.(`ย้ายไปวันที่ ${r.placed.day + 1} ${r.placed.after ? `หลัง ${r.placed.after}` : "เป็นที่แรก"}${r.placed.at ? ` · เริ่ม ${String(r.placed.at).slice(0, 5)}` : ""}`);
      onChanged();
    } catch (e) { setErr((e as Error).message); }
  }

  const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const start = place.start_time && /^\d{2}:\d{2}/.test(place.start_time) ? Number(place.start_time.slice(0, 2)) * 60 + Number(place.start_time.slice(3, 5)) : null;
  const nextAt = seq?.next?.start_time ? seq.next.start_time.slice(0, 5) : null;
  // mainland China: Google Maps is blocked there → Amap link + the Chinese name to show a driver
  const cn = place.lat != null && place.lng != null && inMainlandChina(place.lat, place.lng);
  const localName = place.name.match(/^(.*?)\s*\((.*)\)\s*$/)?.[1] ?? place.name;
  const facts: [string, string | null | undefined][] = [
    ["เวลาเปิด", d.hours],
    ["ราคา", d.price],
    ["ใช้เวลา", place.duration_min ? fmtDur(place.duration_min) : d.duration_min ? fmtDur(d.duration_min) : null],
    ["ช่วงที่ดีที่สุด", d.best_time],
  ];

  return (
    <article ref={top} className="scroll-mt-16 space-y-5 pb-6">
      {seq && onGo && (
        <nav aria-label="ลำดับในวัน" className="flex items-center gap-2 rounded-[16px] bg-sunken p-1.5">
          <button onClick={() => seq.prev && onGo(seq.prev.id)} disabled={!seq.prev} aria-label={seq.prev ? `ก่อนหน้า: ${seq.prev.name}` : "ไม่มีจุดก่อนหน้า"}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-surface disabled:opacity-35"><IconChevronLeft size={18} /></button>
          <div className="min-w-0 flex-1 text-center">
            <p className="text-[14px] font-semibold leading-5">
              <span className="mr-1.5 inline-block size-2.5 rounded-full align-middle" style={{ background: seq.color }} aria-hidden />
              วันที่ {seq.day + 1} · จุดที่ {seq.n} จาก {seq.total}
            </p>
            <p className="truncate text-[12px] text-muted tnum">
              {start != null ? `${hhmm(start)}–${hhmm(start + (place.duration_min ?? 60))} · อยู่ ${fmtDur(place.duration_min ?? 60)}` : "ยังไม่ได้ตั้งเวลา"}
            </p>
          </div>
          <button onClick={() => seq.next && onGo(seq.next.id)} disabled={!seq.next} aria-label={seq.next ? `ถัดไป: ${seq.next.name}` : "จุดสุดท้ายของวัน"}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-white disabled:opacity-35"><IconChevronRight size={18} /></button>
        </nav>
      )}
      {d.photo?.url && (
        <figure className="-mx-1 overflow-hidden rounded-[20px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={d.photo.url} alt={place.name} className="aspect-[16/10] w-full object-cover" />
          <figcaption className="bg-sunken px-3 py-1.5 text-[11px] text-muted">ภาพ: <a href={d.photo.page} target="_blank" rel="noreferrer" className="underline">Wikipedia · {d.photo.title}</a></figcaption>
        </figure>
      )}
      <header>
        <h2 className="text-[20px] font-semibold leading-7">{place.name}</h2>
        <p className="mt-1 flex items-center gap-1.5 text-[14px] text-muted">
          <CatIcon category={place.category} size={15} />
          {(CATEGORY[place.category] ?? CATEGORY.other).label}
          {place.address ? <span className="truncate">· {place.address.split(",").slice(0, 2).join(",")}</span> : null}
        </p>
        {d.why && <p className="mt-2 text-[14px] leading-[22px]">{d.why}</p>}
        {place.source === "video" && place.source_url && (
          <a href={place.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-9 items-center gap-1 text-[14px] font-medium text-accent">ดูคลิปต้นทาง <IconExternal size={13} /></a>
        )}
      </header>

      <div className="grid grid-cols-2 gap-2">
        <Button variant={voted ? "primary" : "secondary"} size="sm" className="whitespace-nowrap" onClick={async () => { await api(`/api/trips/${tripId}/places/${place.id}/vote`, { token, body: {} }); onChanged(); }} aria-pressed={voted}>
          <IconHeart size={17} filled={voted} />{place.votes.length ? `${place.votes.length} คนอยากไป` : "อยากไป"}
        </Button>
        <a href={gmapsPlace(place, cityHint)} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3 text-[14px] font-medium hover:bg-sunken">
          <IconExternal size={16} />เปิด Google Maps
        </a>
      </div>
      {onShare && <button onClick={onShare} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-line bg-surface text-[14px] font-medium hover:bg-sunken">💬 ส่งที่นี่เข้าแชททริป</button>}
      {(() => {
        const v = place.details as { approx?: boolean; unverified?: boolean; closed?: string; wiki?: { title: string; url: string | null; langs: number | null } };
        if (v?.closed) return <p className="rounded-[14px] bg-[#FDECEC] px-3 py-2 text-[13px] text-ink">⛔ ข้อมูล Wikidata ระบุว่าที่นี่ปิดถาวรแล้ว (ปี {v.closed}) เช็กก่อนไป หรือลบออกจากแผน</p>;
        if (v?.unverified) return <p className="rounded-[14px] bg-[#FFF8E8] px-3 py-2 text-[13px] text-ink">⚠ ยังยืนยันไม่ได้ว่าที่นี่มีอยู่จริงและยังเปิดอยู่ (ไม่พบทั้งในแผนที่และ Wikipedia) ค้นชื่อใน Google Maps ก่อนออกเดินทาง</p>;
        return <>
          {v?.approx && <p className="rounded-[14px] bg-[#FFF8E8] px-3 py-2 text-[13px] text-ink">หมุดนี้เป็นตำแหน่งโดยประมาณ แผนที่ยังไม่รู้จักร้านนี้ เช็กที่อยู่จริงในแอปแผนที่ก่อนออกเดินทาง</p>}
          {v?.wiki && <p className="text-[13px] text-muted">✓ ยืนยันแล้ว: มีบทความ{v.wiki.url ? <> <a href={v.wiki.url} target="_blank" rel="noreferrer" className="underline">Wikipedia</a></> : " Wikipedia"}
            {v.wiki.langs ? ` ${v.wiki.langs} ภาษา${v.wiki.langs >= 40 ? " · ที่เที่ยวระดับโลก" : v.wiki.langs >= 12 ? " · เป็นที่รู้จักกว้าง" : ""}` : ""}</p>}
        </>;
      })()}
      {cn && (
        <div className="rounded-[16px] bg-sunken p-3">
          <p className="text-[12px] text-muted">ที่จีนใช้ Google Maps ไม่ได้ · ยื่นชื่อนี้ให้คนขับดู หรือเปิดใน Amap (高德)</p>
          <p className="mt-1 text-[22px] font-semibold leading-8" lang="zh">{localName}</p>
          <a href={`https://uri.amap.com/marker?position=${place.lng},${place.lat}&name=${encodeURIComponent(localName)}&coordinate=wgs84&callnative=1`} target="_blank" rel="noreferrer"
            className="mt-2 inline-flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-[14px] font-semibold text-white"><IconRoute size={16} />นำทางด้วย Amap</a>
        </div>
      )}
      <div className="flex items-center gap-3">
        <label htmlFor="pd-day" className="w-12 shrink-0 text-[14px] font-medium">วัน</label>
        <select id="pd-day" value={place.day_index ?? ""} onChange={(e) => patch({ day_index: e.target.value === "" ? null : Number(e.target.value) })}
          className="h-10 min-w-0 flex-1 rounded-full border border-line bg-surface px-2.5 text-[16px]">
          {dayOptions.map((o) => <option key={String(o.value)} value={o.value ?? ""}>{o.label}</option>)}
        </select>
      </div>

      {place.day_index != null && (
        <div className="flex items-center gap-3">
          <label htmlFor="st" className="w-12 shrink-0 text-[14px] font-medium">เวลา</label>
          <input id="st" type="time" defaultValue={place.start_time ?? ""} key={place.id + (place.start_time ?? "")}
            onBlur={(e) => e.target.value !== (place.start_time ?? "").slice(0, 5) && onTime(e.target.value || null, true)}
            className="h-10 rounded-full border border-line bg-surface px-2 text-[16px] tnum" />
          {place.start_time && (
            <button type="button" onClick={() => onTime(place.start_time!.slice(0, 5), !place.details?.fixed_time)}
              aria-pressed={!!place.details?.fixed_time}
              title={place.details?.fixed_time ? "เวลานี้ล็อกไว้ จุดอื่นจะขยับรอบๆ — แตะเพื่อปลดล็อก" : "ล็อกเวลานี้ไว้ (เช่น จองร้าน รอบโชว์)"}
              className={`h-10 shrink-0 rounded-full border px-3 text-[13px] font-medium ${place.details?.fixed_time ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2"}`}>
              {place.details?.fixed_time ? "🔒 ล็อกเวลา" : "ล็อก"}
            </button>
          )}
          <span className="ml-auto flex gap-1">
            <Button variant="secondary" size="chip" onClick={() => onMove(-1)} aria-label="เลื่อนขึ้น"><IconArrowUp size={16} /></Button>
            <Button variant="secondary" size="chip" onClick={() => onMove(1)} aria-label="เลื่อนลง"><IconArrowDown size={16} /></Button>
          </span>
        </div>
      )}

      {loading ? (
        <div className="space-y-2" aria-label="กำลังสรุปข้อมูล">
          <div className="skeleton h-4 w-full" /><div className="skeleton h-4 w-11/12" /><div className="skeleton h-4 w-2/3" />
          <div className="grid grid-cols-2 gap-2 pt-2"><div className="skeleton h-12" /><div className="skeleton h-12" /></div>
        </div>
      ) : d.summary ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-line py-4">
            {facts.filter(([, v]) => v).map(([k, v]) => (
              <div key={k}><dt className="text-[12px] text-muted">{k}</dt><dd className="text-[14px] font-medium leading-[22px]">{v}</dd></div>
            ))}
          </dl>
          <section>
            <p className="leading-[24px]">{d.summary}</p>
            <p className="mt-1 text-[12px] text-muted">สรุปโดย AI จากข้อมูลทั่วไป ราคาและเวลาเปิดอาจเปลี่ยน</p>
          </section>
          {d.must_try && d.must_try.length > 0 && (
            <section>
              <h3 className="text-[15px] font-semibold">ห้ามพลาด</h3>
              <ul className="mt-2 flex flex-wrap gap-1.5">{d.must_try.map((x) => <li key={x} className="rounded-[8px] bg-sunken px-2.5 py-1 text-[14px]">{x}</li>)}</ul>
            </section>
          )}
          {d.highlights && d.highlights.length > 0 && (
            <section>
              <h3 className="text-[15px] font-semibold">ไฮไลต์</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[14px] leading-[22px] marker:text-muted">{d.highlights.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          )}
          {d.tips && d.tips.length > 0 && (
            <section>
              <h3 className="text-[15px] font-semibold">ทริคก่อนไป</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[14px] leading-[22px] marker:text-muted">{d.tips.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          )}
          {d.getting_there && <p className="text-[14px]"><span className="font-semibold">การเดินทาง </span>{d.getting_there}</p>}
        </>
      ) : err ? (
        <p className="text-[14px] text-muted">{err}</p>
      ) : null}

      {seq?.next && onGo && (
        <section className="rounded-[16px] border border-line p-3">
          <p className="text-[12px] text-muted">ถัดไป{nextAt ? ` · ${nextAt}` : ""}</p>
          <button onClick={() => onGo(seq.next!.id)} className="flex min-h-10 w-full items-center gap-2 text-left">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{seq.next.name}</span><IconChevronRight size={18} />
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            {seq.legNext && <span className="rounded-full bg-sunken px-2.5 py-1 tnum">{seq.legNext.label} · {seq.legNext.km.toFixed(1)} กม.</span>}
            {place.lat != null && seq.next.lat != null && (
              <a href={seq.legNext?.url ?? `https://www.google.com/maps/dir/?api=1&origin=${place.lat},${place.lng}&destination=${seq.next.lat},${seq.next.lng}`} target="_blank" rel="noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 font-semibold text-white"><IconRoute size={15} />นำทางไปจุดถัดไป</a>
            )}
          </div>
        </section>
      )}
      {seq && !seq.next && <p className="rounded-[14px] bg-sunken px-3 py-2 text-[13px] text-muted">จุดสุดท้ายของวันที่ {seq.day + 1} แล้ว</p>}

      {onSuggest && place.category !== "stay" && place.category !== "transport" && <NearHere key={place.id} tripId={tripId} token={token} place={place} onPick={onSuggest} />}

      <section>
        <label htmlFor="notes" className="text-[15px] font-semibold">โน้ตของกลุ่ม</label>
        <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (place.notes ?? "") && patch({ notes })}
          rows={2} maxLength={1000} placeholder="เช่น จองโต๊ะแล้ว 19:00 · ร้านปิดวันพุธ" className={`${inputCls} mt-1.5 h-auto py-2.5`} />
      </section>

      <footer className="flex items-center justify-between border-t border-line pt-4 text-[12px] text-muted">
        <span>{adder ? `${adder.name} เพิ่มไว้` : ""}{place.source === "video" ? " จากคลิป" : place.source === "ai" ? " จากคำแนะนำ" : ""}</span>
        <Button variant="danger" size="chip" onClick={async () => { if (!confirm(`ลบ ${place.name} ออกจากทริป?`)) return; await api(`/api/trips/${tripId}/places/${place.id}`, { token, method: "DELETE" }); onDeleted(); }}>
          <IconTrash size={16} />ลบ
        </Button>
      </footer>
    </article>
  );
}

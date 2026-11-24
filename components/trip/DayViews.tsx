"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, getSessions, saveSession, forgetSession } from "@/lib/client/api";
import { CATEGORY, DAY_COLORS, NEUTRAL, dayList, fmtDur, fmtKm, fmtRange, gmapsDirections, inkOn, navUrl, travel } from "@/lib/client/util";
import type { Candidate, DayRoute, Leg, MemberT, Place, TripState } from "@/lib/types";
import { Button, Toast } from "@/components/ui/Field";
import { IconChevronRight, IconCar, IconChevronLeft, IconHeart, IconPlus, IconRoute, IconVideo, IconWalk, IconWand, IconUtensils, IconLocate, IconBed, IconBus, IconWallet } from "@/components/icons";
import { CatIcon } from "./shared";
import { MODES, MOVING, isMode, km, type Mode } from "@/lib/presence";
import { stayForDay } from "@/lib/client/stays";
import { avatarDataUrl } from "@/lib/client/avatar";
import { SuggestSlot, toMin, toHHMM, type PickFn, type SuggestKind } from "./Suggest";
import { TravelLines, transferMin } from "./TravelPanel";
import { mapAppAt, rideGuide } from "@/lib/transport";
import { routeUrl } from "@/lib/maplinks";

/** "外滩 (The Bund)" → "The Bund"; "วัดพระสิงห์ (Wat Phra Singh)" → "วัดพระสิงห์" */
export function shortName(name: string) {
  const m = name.match(/^(.*?)\s*\((.*)\)\s*$/);
  if (!m) return name;
  return /[\u0E00-\u0E7F]/.test(m[1]) || !/[A-Za-z\u0E00-\u0E7F]/.test(m[2]) ? m[1] : m[2];
}

export function isToday(d?: Date) {
  if (!d) return false;
  const n = new Date();
  return d.getUTCFullYear() === n.getFullYear() && d.getUTCMonth() === n.getMonth() && d.getUTCDate() === n.getDate();
}

export function PanelTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-[20px] font-semibold leading-7">{title}</h2>
      {sub && <p className="mt-1 text-[14px] text-muted">{sub}</p>}
    </div>
  );
}

function Thumb({ p, color, n }: { p: Place; color?: string; n?: number }) {
  const ph = p.details?.photo?.url;
  return (
    <span className="relative size-12 shrink-0">
      {ph ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={ph} alt="" loading="lazy" className="size-12 rounded-[12px] object-cover" />
      ) : (
        <span className="grid size-12 place-items-center rounded-[12px] text-ink/70" style={{ background: color ? `${color}22` : "var(--color-sunken)" }}>
          <CatIcon category={p.category} size={20} />
        </span>
      )}
      {n != null && color && (
        <span className={`absolute -left-1.5 -top-1.5 grid size-6 place-items-center rounded-full border-2 border-white text-[11px] font-semibold tnum ${inkOn(color) ? "text-ink" : "text-white"}`} style={{ background: color }}>{n}</span>
      )}
    </span>
  );
}

function Row({ p, me, onOpen, color, n }: { p: Place; me: string; onOpen: (id: string) => void; color?: string; n?: number }) {
  const cat = CATEGORY[p.category] ?? CATEGORY.other;
  const voted = p.votes.includes(me);
  const meta = [p.start_time ? `${p.start_time.slice(0, 5)}${p.details?.fixed_time ? " 🔒" : ""}` : null, cat.label, p.duration_min ? fmtDur(p.duration_min) : null, p.lat == null ? "ยังไม่มีหมุด" : null].filter(Boolean).join(" · ");
  return (
    <button onClick={() => onOpen(p.id)} className="flex w-full items-center gap-3 rounded-[16px] p-1.5 text-left hover:bg-sunken">
      <Thumb p={p} color={color} n={n} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] font-semibold leading-6 ${p.visited ? "text-muted line-through" : ""}`}>{p.name}</span>
        <span className="block truncate text-[12px] leading-[18px] text-muted tnum">{meta}</span>
        {p.details?.why && <span className="block truncate text-[12px] leading-[18px] text-muted/90">{p.details.why}</span>}
      </span>
      {p.votes.length > 0 && (
        <span className={`flex shrink-0 items-center gap-1 pr-1 text-[12px] font-medium tnum ${voted ? "text-danger" : "text-muted"}`} aria-label={`${p.votes.length} คนอยากไป`}>
          <IconHeart size={15} filled={voted} />{p.votes.length}
        </span>
      )}
    </button>
  );
}

type End = { lat: number | null; lng: number | null; name: string } | undefined;
function LegRow({ leg, color, from, to }: { leg: Leg | undefined; color: string; from?: End; to?: End }) {
  const [open, setOpen] = useState(false);
  const g = open && leg && from?.lat != null && to?.lat != null
    ? rideGuide({ lat: from.lat, lng: from.lng!, name: from.name }, { lat: to.lat, lng: to.lng!, name: to.name }, leg.km, null) : null;
  return (
    <div className="pl-[29px]">
      <div className="flex min-h-9 items-center gap-3">
        <span className="h-8 w-0 border-l-2 border-dotted" style={{ borderColor: color }} />
        {leg && (
          <span className="ml-[18px] flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-muted tnum">
            {/* tap the leg: every sensible way to get there, how to pay, what to show the driver */}
            <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="-my-1.5 flex min-h-9 min-w-0 items-center gap-1.5 rounded-full pr-2 text-left hover:text-ink">
              {leg.mode === "walk" ? <IconWalk size={14} /> : leg.mode === "transit" ? <IconBus size={14} /> : <IconCar size={14} />}
              <span className="truncate">{leg.label} · {fmtKm(leg.km)}</span>
              {from && to && <span className="shrink-0 text-accent">{open ? "ซ่อน" : "วิธีไป"}</span>}
            </button>
            <a href={from?.lat != null && to?.lat != null ? routeUrl({ lat: from.lat, lng: from.lng!, name: from.name }, { lat: to.lat, lng: to.lng!, name: to.name }, leg.mode) : leg.url} target="_blank" rel="noreferrer" className="-my-1.5 ml-auto inline-flex h-9 shrink-0 items-center rounded-full px-3 font-medium text-accent hover:bg-accent-tint">นำทาง</a>
          </span>
        )}
      </div>
      {g && (
        <div className="mb-2 ml-[20px] mt-1 space-y-2 rounded-[14px] bg-sunken p-3 text-[13px]">
          {g.options.map((o) => (
            <div key={o.kind} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-muted">{o.kind === "walk" ? <IconWalk size={15} /> : o.kind === "transit" ? <IconBus size={15} /> : <IconCar size={15} />}</span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{o.title} · ~{o.min} นาที{o.cost ? <span className="font-normal text-muted"> · {o.cost}</span> : null}</p>
                <p className="whitespace-pre-line text-[12px] leading-5 text-muted">{o.how}</p>
              </div>
              <a href={o.url} target="_blank" rel="noreferrer" className="inline-flex h-8 shrink-0 items-center rounded-full border border-line bg-surface px-3 text-[12px] font-medium hover:bg-line/40">เปิดเส้นทาง</a>
            </div>
          ))}
          {g.driverText && (
            <div className="rounded-[12px] bg-surface p-2.5">
              <p className="text-[11px] text-muted">ยื่นให้คนขับดู</p>
              <p className="text-[20px] font-semibold leading-7" lang={/[\uac00-\ud7af]/.test(g.driverText) ? "ko" : /[\u3040-\u30ff]/.test(g.driverText) ? "ja" : "zh"}>{g.driverText}</p>
            </div>
          )}
          <p className="text-[11px] text-muted">เวลาและราคาเป็นค่าประมาณ สายรถและจุดเปลี่ยนสายดูใน {g.mapApp}</p>
        </div>
      )}
    </div>
  );
}

function HotelRow({ hotel, label, onOpen }: { hotel: Place; label: string; onOpen: (id: string) => void }) {
  return (
    <button onClick={() => onOpen(hotel.id)} className="flex w-full items-center gap-3 rounded-[16px] bg-sunken p-1.5 text-left hover:bg-line/60">
      <span className="grid size-12 shrink-0 place-items-center rounded-[12px] bg-ink text-lime"><IconBed size={20} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-muted">{label}</span>
        <span className="block truncate text-[15px] font-semibold leading-6">{hotel.name}</span>
      </span>
    </button>
  );
}

export function DayView({ index, label, theme, color, places, me, route, hotel, dirUrl, onOpen, onAdd, onFood, onImport, onPlan, onGuide, today, sharing, onSquad, onSortTime,
  tripId, token, meals, lastDay, onPick, onReplanDay, canReplanDay, planning, members, onTravel, onEdit }: {
  index: number; label: string; theme?: string; color: string; places: Place[]; me: string; route: DayRoute | null; hotel: Place | null; dirUrl: string | null;
  onOpen: (id: string) => void; onAdd: () => void; onFood: () => void; onImport: () => void; onPlan: () => void; onGuide: () => void;
  today?: boolean; sharing?: boolean; onSquad?: () => void; onSortTime?: () => void;
  tripId?: string; token?: string; meals?: string[]; lastDay?: boolean; onPick?: PickFn; onReplanDay?: () => Promise<void>; canReplanDay?: boolean; planning?: boolean; members?: MemberT[]; onTravel?: () => void; onEdit?: () => void;
}) {
  const [confirmDay, setConfirmDay] = useState(false);
  const times = places.map((p) => p.start_time).filter(Boolean) as string[];
  const unordered = times.some((t, i) => i > 0 && t < times[i - 1]);
  // legs from the road-route API line up with [hotel?] + stops + [hotel?]
  const routeOk = !!route && Array.isArray(route.stopIds) && Array.isArray(route.legs) && route.stopIds.length === places.filter((p) => p.lat != null).length;
  const legs = routeOk ? route!.legs : [];
  // older cached responses have no flags: hotel at both ends
  const hStart = routeOk && !!route!.hotel && (route!.hotelStart ?? true);
  const hEnd = routeOk && !!route!.hotel && (route!.hotelEnd ?? true);
  const off = hStart ? 1 : 0;
  const located = places.filter((p) => p.lat != null);
  const legAfter = (p: Place) => { const k = located.indexOf(p); return k >= 0 && k < located.length - 1 ? legs[k + off] : undefined; };
  const nextOf = (p: Place) => { const k = located.indexOf(p); return k >= 0 ? located[k + 1] : undefined; };
  const total = legs.reduce((s, l) => s + l.min, 0);

  // smart fill: free time ≥ 2h between stops, and lunch/dinner the plan forgot → a slot with 3 nearby ideas
  const slots = new Map<number, React.ReactNode>(); // key = index of the stop it follows (-1 = before the first)
  if (onPick && tripId && token && places.length >= 2 && !planning) {
    const st = places.map((p) => toMin(p.start_time));
    const ends = places.map((p, i) => (st[i] != null ? st[i]! + (p.duration_min ?? 60) : null));
    const timed = st.filter((t) => t != null) as number[];
    if (timed.length >= 2) {
      const first = Math.min(...timed), lastEnd = Math.max(...(ends.filter((t) => t != null) as number[]));
      const eats = (lo: number, hi: number, night = false) => places.some((p, i) => (p.category === "food" || p.category === "cafe" || (night && p.category === "nightlife")) && st[i] != null && st[i]! >= lo && st[i]! <= hi);
      const want = meals ?? ["breakfast", "lunch", "dinner"];
      const mealSlot = (meal: "lunch" | "dinner", target: number, minAt: number) => {
        let k = -1;
        st.forEach((t, i) => { if (t != null && t <= target) k = i; });
        const prev = k >= 0 ? places[k] : null, next = places[k + 1] ?? null;
        const anchor = [prev, next].find((x) => x?.lat != null && x.lng != null);
        if (!anchor) return;
        const from = k >= 0 ? ends[k] : null;
        const at = Math.max(minAt, from ?? 0);
        const th = meal === "lunch" ? "กลางวัน" : "เย็น";
        slots.set(k, <SuggestSlot key={`m${meal}`} tripId={tripId} token={token} tone="meal" title={`ยังไม่มีมื้อ${th}`} sub={`ร้านแถว ${anchor.name} · ราว ${toHHMM(at)}`}
          kinds={["food"]} meal={meal} at={toHHMM(at)} anchor={{ lat: anchor.lat!, lng: anchor.lng!, label: anchor.name }} onPick={onPick}
          ctx={{ day: index, after: prev, first: places[0], from, until: next ? st[k + 1] : null, minAt }} />);
      };
      // breakfast: only when the day starts late enough that nobody would have eaten yet
      if (want.includes("breakfast") && index > 0 && first >= 8 * 60 + 30 && !eats(6 * 60, 10 * 60 + 30)) {
        const anchor = hotel?.lat != null ? hotel : places.find((x) => x.lat != null);
        if (anchor) slots.set(-1, <SuggestSlot key="mbreakfast" tripId={tripId} token={token} tone="meal" title="ยังไม่มีมื้อเช้า" sub={`ร้านแถว ${anchor.name} · ก่อนออกเที่ยว`}
          kinds={["food", "cafe"]} meal="breakfast" at="07:30" anchor={{ lat: anchor.lat!, lng: anchor.lng!, label: anchor.name }} onPick={onPick}
          ctx={{ day: index, after: null, first: places[0], from: null, until: st[0], minAt: Math.max(7 * 60, (st[0] ?? 9 * 60) - 75) }} />);
      }
      if (want.includes("lunch") && first <= 12 * 60 && lastEnd >= 14 * 60 && !eats(11 * 60, 14 * 60 + 30)) mealSlot("lunch", 12 * 60, 11 * 60 + 30);
      if (want.includes("dinner") && lastEnd >= 16 * 60 + 30 && !(lastDay && lastEnd < 18 * 60) && !eats(17 * 60, 21 * 60 + 30, true)) mealSlot("dinner", 18 * 60 + 30, 18 * 60);
      for (let i = 0; i < places.length - 1; i++) {
        const a = places[i];
        if (slots.has(i) || ends[i] == null || st[i + 1] == null || a.lat == null || a.lng == null) continue;
        const travel = legAfter(a)?.min ?? 20;
        const free = st[i + 1]! - ends[i]! - travel;
        if (free < 120) continue;
        const h = ends[i]!;
        const kinds: SuggestKind[] = (h >= 11 * 60 && h < 13 * 60) || (h >= 17 * 60 + 30 && h < 20 * 60) ? ["food", "attraction", "cafe"]
          : h >= 14 * 60 && h < 17 * 60 + 30 ? ["cafe", "attraction", "food"] : ["attraction", "cafe", "food"];
        slots.set(i, <SuggestSlot key={`g${i}`} tripId={tripId} token={token} title={`ว่าง ${fmtDur(Math.floor(free / 15) * 15)} แวะที่ไหนดี`}
          sub={`${toHHMM(h)}–${toHHMM(st[i + 1]!)} · ใกล้ ${a.name}`} kinds={kinds} at={toHHMM(h)}
          anchor={{ lat: a.lat, lng: a.lng, label: a.name }} onPick={onPick}
          ctx={{ day: index, after: a, from: h, until: st[i + 1]! }} />);
      }
    }
  }
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold leading-[26px]">วันที่ {index + 1} · {label.replace(/^วัน/, "")}</h2>
          <p className="truncate text-[12px] text-muted">{theme ? `${theme} · ` : ""}{places.length ? `${places.length} ที่${total ? ` · เดินทางรวม ~${fmtDur(total)}` : ""}` : "ยังไม่มีแผน"}</p>
        </div>
        <span className="flex shrink-0 gap-1.5">
          {onEdit && <button onClick={onEdit} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-3 text-[13px] font-semibold text-white">✏️ แก้/เรียง</button>}
          <button onClick={onGuide} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-medium hover:bg-sunken"><IconBed size={15} />ที่พัก</button>
        </span>
      </div>

      {today && (
        <button onClick={onSquad} className="mt-3 flex w-full items-center gap-3 rounded-[16px] bg-lime px-4 py-3 text-left text-ink">
          <span className="text-[24px]" aria-hidden="true">🎒</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">วันนี้แหละ วันที่ {index + 1} ของทริป!</span>
            <span className="block text-[13px]">{sharing ? "ดูว่าแก๊งอยู่ไหน ส่งอีโมจิ หรือปักธงนัดเจอ" : "เปิดตำแหน่งให้แก๊งเห็น จะได้ตามหากันง่าย"}</span>
          </span>
          <IconChevronRight size={18} />
        </button>
      )}
      {today && <NowCard places={places} hotel={hotel} />}
      {members && onTravel && index === 0 && members.some((m) => m.travel?.arrive) && (
        <div className="mt-3 rounded-[16px] bg-sunken px-3 py-2.5">
          <button onClick={onTravel} className="flex min-h-8 w-full items-center gap-2 text-left text-[14px] font-semibold"><span aria-hidden>🛬</span><span className="flex-1">มาถึงกี่โมง</span><IconChevronRight size={16} /></button>
          <TravelLines members={members} which="arrive" />
        </div>
      )}
      {members && onTravel && lastDay && index > 0 && (
        <div className="mt-3 rounded-[16px] bg-sunken px-3 py-2.5">
          <button onClick={onTravel} className="flex min-h-8 w-full items-center gap-2 text-left text-[14px] font-semibold"><span aria-hidden>👋</span>
            <span className="flex-1">แยกย้าย{members.some((m) => m.travel?.depart) ? "" : " · ใส่เที่ยวบินขากลับ"}</span><IconChevronRight size={16} /></button>
          {members.some((m) => m.travel?.depart)
            ? <TravelLines members={members} which="depart" transfer={transferMin(hotel, places.find((p) => p.category === "transport") ?? null)} />
            : <p className="text-[12px] text-muted">ใส่แล้วจะบอกว่าแต่ละคนต้องออกจากที่พักกี่โมง</p>}
        </div>
      )}
      {unordered && onSortTime && (
        <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-[#FFF4D6] px-3 py-2 text-[13px] text-ink" role="status">
          <span className="min-w-0 flex-1">ลำดับกับเวลายังไม่ตรงกัน</span>
          <button onClick={onSortTime} className="h-9 shrink-0 rounded-full bg-ink px-3 font-semibold text-white">เรียงตามเวลา</button>
        </div>
      )}
      {places.length === 0 ? (
        <div className="mt-4 rounded-[20px] bg-ink p-5 text-white">
          <p className="text-[17px] font-semibold">วันนี้ยังว่าง</p>
          <p className="mt-1 text-[14px] text-white/75">{onReplanDay && canReplanDay ? "ให้ปักไปจัดวันนี้ให้ ใกล้ที่พักและไม่ซ้ำวันอื่น หรือเพิ่มเองทีละที่" : "ให้ปักไปจัดที่เที่ยว ร้านกิน และเส้นทางให้ทั้งทริปในครั้งเดียว หรือเพิ่มเองทีละที่"}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {onReplanDay && canReplanDay
              ? <Button disabled={planning} onClick={() => onReplanDay()} className="bg-lime text-ink hover:bg-lime/90"><IconWand size={16} />{planning ? "กำลังจัด…" : "จัดเฉพาะวันนี้"}</Button>
              : <Button onClick={onPlan} className="bg-lime text-ink hover:bg-lime/90"><IconWand size={16} />จัดทริปให้อัตโนมัติ</Button>}
            <Button variant="secondary" onClick={onAdd} className="border-white/20 bg-transparent text-white hover:bg-white/10"><IconPlus size={16} />เพิ่มเอง</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          {hotel && hStart && <><HotelRow hotel={hotel} label={lastDay && !hEnd ? "เช็กเอาต์ ออกจากที่พัก" : "ออกจากที่พัก"} onOpen={onOpen} /><LegRow leg={legs[0]} color={color} from={hotel} to={located[0]} /></>}
          {slots.get(-1)}
          <ol>
            {places.map((p, i) => (
              <li key={p.id}>
                <Row p={p} me={me} onOpen={onOpen} color={color} n={i + 1} />
                {slots.get(i)}
                {i < places.length - 1 && <LegRow leg={legAfter(p)} color={color} from={p} to={nextOf(p)} />}
              </li>
            ))}
          </ol>
          {hotel && hEnd && <><LegRow leg={legs[legs.length - 1]} color={color} from={located[located.length - 1]} to={hotel} /><HotelRow hotel={hotel} label={index === 0 && !hStart ? "เช็กอินเข้าที่พัก" : "กลับที่พัก"} onOpen={onOpen} /></>}
          <div className="mt-4 flex flex-wrap gap-2">
            {dirUrl && <a href={dirUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-[14px] font-semibold text-white"><IconRoute size={16} />นำทางทั้งวัน</a>}
            <Button size="sm" variant="secondary" onClick={onAdd}><IconPlus size={16} />เพิ่มที่</Button>
            <Button size="sm" variant="secondary" onClick={onFood}><IconUtensils size={16} />ร้านอาหารแถวนี้</Button>
            <Button size="sm" variant="secondary" onClick={onImport}><IconVideo size={16} />จากคลิป</Button>
            {onReplanDay && canReplanDay && !planning && (
              <Button size="sm" variant={confirmDay ? "primary" : "secondary"} onClick={async () => { if (!confirmDay) return setConfirmDay(true); setConfirmDay(false); await onReplanDay(); }}
                onBlur={() => setConfirmDay(false)}><IconWand size={16} />{confirmDay ? "แตะอีกครั้งเพื่อจัดวันนี้ใหม่" : "จัดเฉพาะวันนี้"}</Button>
            )}
          </div>
          {confirmDay && <p className="mt-2 text-[12px] text-muted" role="status">ระบบจะจัดเฉพาะวันที่ {index + 1} ใหม่ ที่ที่เพื่อนเพิ่มเอง กดหัวใจ หรือไปแล้ว จะไม่หาย วันอื่นไม่เปลี่ยน</p>}
          <p className="mt-3 text-[12px] text-muted">{routeOk && route!.exact ? "เวลาเดินทางคำนวณจากถนนจริง (ไม่รวมรถติด)" : "เวลาเดินทางเป็นค่าประมาณ"} · กด “นำทาง” เพื่อเปิด {(() => { const p0 = places.find((p) => p.lat != null); return p0 ? mapAppAt({ lat: p0.lat!, lng: p0.lng! }) : "Google Maps"; })()}</p>
        </div>
      )}
    </div>
  );
}

export function WishView({ places, me, days, planned, onOpen, onImport, onAdd, onRecommend, onAutoplan, onPlan }: {
  places: Place[]; me: string; days: number; planned: boolean; onOpen: (id: string) => void; onImport: (url: string) => void;
  onAdd: () => void; onRecommend: () => void; onAutoplan: () => void; onPlan: () => void;
}) {
  const [url, setUrl] = useState("");
  return (
    <div className="space-y-4">
      {!planned && (
        <div className="rounded-[20px] bg-ink p-5 text-white">
          <p className="text-[17px] font-semibold">ให้ปักไปจัดทริปให้ทั้งหมด</p>
          <p className="mt-1 text-[14px] text-white/75">เลือกสไตล์ไม่กี่อย่าง ได้แผนรายวัน ร้านกิน ที่พัก และวิธีเดินทางครบ ภายในไม่ถึงนาที</p>
          <Button onClick={onPlan} className="mt-4 bg-lime text-ink hover:bg-lime/90"><IconWand size={16} />จัดทริปให้อัตโนมัติ</Button>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); onImport(url.trim()); }} className="rounded-[20px] bg-sunken p-3">
        <label htmlFor="quick-imp" className="px-1 text-[14px] font-medium">เจอคลิปเที่ยวน่าไป? วางลิงก์ได้เลย</label>
        <div className="mt-2 flex gap-2">
          <input id="quick-imp" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="ลิงก์ TikTok หรือ Reel"
            className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[16px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/25" />
          <Button size="sm" type="submit" className="h-11">ดึงสถานที่</Button>
        </div>
      </form>

      {places.length === 0 ? (
        <p className="px-1 text-[14px] text-muted">ยังไม่มีที่ที่รอจัดลงวัน ที่ที่เพิ่มแบบไม่เลือกวันจะมาอยู่ตรงนี้</p>
      ) : (
        <div>
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[17px] font-semibold">รอจัดลงวัน · {places.length}</h2>
            {days > 0 && places.some((p) => p.lat != null) && (
              <Button size="chip" variant="secondary" onClick={onAutoplan}>แบ่งลงวันตามโซน</Button>
            )}
          </div>
          <p className="px-1 text-[12px] text-muted">กดหัวใจที่อยากไป ที่ที่เพื่อนโหวตเยอะจะขึ้นก่อน</p>
          <ul className="mt-1.5 space-y-0.5">
            {places.map((p) => <li key={p.id}><Row p={p} me={me} onOpen={onOpen} /></li>)}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onAdd}><IconPlus size={16} />ค้นหาเพิ่มเอง</Button>
        <Button size="sm" variant="secondary" onClick={onRecommend}><IconLocate size={16} />แนะนำที่น่าไป</Button>
      </div>
    </div>
  );
}

/** Tour-leader strip for today: what is happening now, what is next, and one tap to navigate there. */
function NowCard({ places, hotel }: { places: Place[]; hotel: Place | null }) {
  const [now, setNow] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
  useEffect(() => { const t = setInterval(() => { const d = new Date(); setNow(d.getHours() * 60 + d.getMinutes()); }, 30_000); return () => clearInterval(t); }, []);
  const timed = places.filter((p) => toMin(p.start_time) != null);
  if (!timed.length) return null;
  const cur = timed.find((p) => toMin(p.start_time)! <= now && now < toMin(p.start_time)! + (p.duration_min ?? 60));
  const next = timed.find((p) => toMin(p.start_time)! > now);
  const target = next ?? (cur ? null : hotel);
  const wait = next ? toMin(next.start_time)! - now : 0;
  const title = cur ? `ตอนนี้: ${shortName(cur.name)}` : next ? (next === timed[0] ? `เริ่มวันนี้ที่ ${shortName(next.name)}` : `ถัดไป: ${shortName(next.name)}`) : "จบแผนวันนี้แล้ว 🎉";
  const sub = cur
    ? `ถึง ${toHHMM(toMin(cur.start_time)! + (cur.duration_min ?? 60))}${next ? ` · ต่อไป ${shortName(next.name)} ${next.start_time!.slice(0, 5)}` : " · จุดสุดท้ายของวัน"}`
    : next ? `${next.start_time!.slice(0, 5)} · ${wait >= 60 ? `อีก ${fmtDur(wait)}` : `อีก ${wait} นาที`}` : hotel ? `กลับที่พัก ${shortName(hotel.name)}` : "พักผ่อนได้เลย";
  return (
    <div className="mt-3 flex items-center gap-3 rounded-[16px] bg-ink px-4 py-3 text-white" role="status">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">{title}</span>
        <span className="block truncate text-[13px] text-white/75 tnum">{sub}</span>
      </span>
      {target && <a href={navUrl(target)} target="_blank" rel="noreferrer" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-lime px-3.5 text-[14px] font-semibold text-ink"><IconRoute size={16} />นำทาง</a>}
    </div>
  );
}

/** "ทั้งทริป": the whole journey on one screen — every day as a card, tap to open that day. */
export function AllView({ days, hotels, summary, onDay, onOpen, onGuide, prep, tripId, startDate, members, onTravel }: {
  days: { index: number; label: string; color: string; theme?: string; places: Place[] }[]; hotels: Place[]; summary?: string;
  onDay: (d: number) => void; onOpen: (id: string) => void; onGuide: () => void;
  prep?: string[]; tripId?: string; startDate?: string | null; members?: MemberT[]; onTravel?: () => void;
}) {
  const total = days.reduce((n, d) => n + d.places.length, 0);
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold leading-[26px]">ทั้งทริป {days.length} วัน</h2>
          <p className="text-[12px] text-muted">{total} ที่ · แตะวันเพื่อดูเส้นทางและเวลาของวันนั้น</p>
        </div>
        <button onClick={onGuide} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-medium hover:bg-sunken"><IconBed size={15} />ที่พัก/เดินทาง</button>
      </div>
      {summary && <p className="mt-2 text-[14px] leading-[22px]">{summary}</p>}
      {onTravel && members && (
        <button onClick={onTravel} className="mt-3 flex w-full items-center gap-3 rounded-[16px] border border-line bg-surface px-3 py-2.5 text-left hover:bg-sunken">
          <span className="text-[20px]" aria-hidden>✈️</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">เที่ยวบินและแยกย้าย</span>
            <span className="block truncate text-[12px] text-muted">{members.filter((m) => m.travel?.arrive || m.travel?.depart).length
              ? `กรอกแล้ว ${members.filter((m) => m.travel?.arrive || m.travel?.depart).length} จาก ${members.length} คน` : "ใส่เวลาไป–กลับของแต่ละคน ไม่บังคับ"}</span>
          </span>
          <IconChevronRight size={18} />
        </button>
      )}
      {prep && prep.length > 0 && tripId && <PrepList items={prep} tripId={tripId} startDate={startDate ?? null} />}
      {hotels.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {hotels.map((h) => (
            <li key={h.id}><button onClick={() => onOpen(h.id)} className="flex w-full items-center gap-2 rounded-[14px] bg-sunken px-3 py-2 text-left text-[14px]">
              <IconBed size={16} /><span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
              <span className="shrink-0 text-[12px] text-muted">{h.day_index != null ? `เข้าพักวันที่ ${h.day_index + 1}` : ""}{h.details?.nights ? ` · ${h.details.nights} คืน` : ""}</span>
            </button></li>
          ))}
        </ul>
      )}
      <ol className="mt-3 space-y-2">
        {days.map((d) => {
          const timed = d.places.filter((p) => p.start_time);
          const first = timed[0]?.start_time?.slice(0, 5), lastP = timed[timed.length - 1];
          const end = lastP ? toHHMM((toMin(lastP.start_time) ?? 0) + (lastP.duration_min ?? 60)) : null;
          return (
            <li key={d.index}>
              <button onClick={() => onDay(d.index)} className="flex w-full items-stretch gap-3 rounded-[16px] border border-line bg-surface p-3 text-left hover:bg-sunken">
                <span className="w-1.5 shrink-0 rounded-full" style={{ background: d.color }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[15px] font-semibold">วันที่ {d.index + 1} · {d.label.replace(/^วัน/, "")}</span>
                    <span className="shrink-0 text-[12px] text-muted tnum">{first && end ? `${first}–${end}` : ""}</span>
                  </span>
                  {d.theme && <span className="block truncate text-[13px] text-muted">{d.theme}</span>}
                  <span className="mt-1 block text-[13px] leading-5">
                    {d.places.length ? d.places.map((p) => shortName(p.name)).join(" → ") : <span className="text-muted">ยังไม่มีแผน</span>}
                  </span>
                </span>
                <span className="self-center text-muted"><IconChevronRight size={18} /></span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** "ก่อนเดินทาง": the tour leader's to-do list. Ticks are kept on this phone (each person packs for themselves). */
function PrepList({ items, tripId, startDate }: { items: string[]; tripId: string; startDate: string | null }) {
  const key = `pinpai.prep.${tripId}`;
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => { try { setDone(JSON.parse(localStorage.getItem(key) ?? "[]")); } catch {} }, [key]);
  const toggle = (t: string) => setDone((d) => { const n = d.includes(t) ? d.filter((x) => x !== t) : [...d, t]; try { localStorage.setItem(key, JSON.stringify(n)); } catch {} return n; });
  const left = startDate ? Math.ceil((Date.parse(`${startDate}T00:00:00`) - Date.now()) / 864e5) : null;
  const n = items.filter((t) => done.includes(t)).length;
  const [open, setOpen] = useState(true);
  if (left != null && left < -1) return null;
  return (
    <section className="mt-3 rounded-[16px] border border-line bg-surface p-3">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-9 w-full items-center gap-2 text-left">
        <span className="text-[18px]" aria-hidden>🧳</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">ก่อนเดินทาง{left != null && left > 0 ? ` · อีก ${left} วัน` : left === 0 ? " · วันนี้!" : ""}</span>
          <span className="block text-[12px] text-muted">เตรียมแล้ว {n} จาก {items.length} อย่าง</span>
        </span>
        <span className="text-[13px] font-medium text-muted">{open ? "ซ่อน" : "ดู"}</span>
      </button>
      {open && (
        <ul className="mt-1">
          {items.map((t) => (
            <li key={t}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-[14px] leading-[22px]">
                <input type="checkbox" checked={done.includes(t)} onChange={() => toggle(t)} className="mt-0.5 size-5 shrink-0 accent-[#16211c]" />
                <span className={done.includes(t) ? "text-muted line-through" : ""}>{t}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

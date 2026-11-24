"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { avatarDataUrl } from "@/lib/client/avatar";
import { Button } from "@/components/ui/Field";
import { IconExternal } from "@/components/icons";
import type { MemberT, Place, Travel, TravelLeg } from "@/lib/types";

const toMin = (t: string | null | undefined) => (t && /^\d{2}:\d{2}/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const hhmm = (m: number) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String(((m % 1440) + 1440) % 60).padStart(2, "0")}`;
const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
/** a flight needs ~2.5 h at the airport, a train/bus ~40 min */
export const isFlight = (l: TravelLeg | null | undefined) => !!l && (!!l.flight || !l.place || /สนามบิน|airport|机场|空港|✈/i.test(l.place));
/** minutes from the hotel to the airport/station: from the map when both are pinned, otherwise a safe hour */
export function transferMin(hotel: Place | null, hub: Place | null) {
  if (hotel?.lat == null || hotel.lng == null || hub?.lat == null || hub.lng == null) return 60;
  const road = km({ lat: hotel.lat, lng: hotel.lng }, { lat: hub.lat, lng: hub.lng }) * 1.3;
  return Math.max(20, Math.round(((road / 35) * 60 + 15) / 5) * 5);
}
/** when to walk out of the hotel to make this departure */
export function leaveBy(l: TravelLeg | null | undefined, transfer: number) {
  const t = toMin(l?.time);
  if (t == null) return null;
  return hhmm(t - (isFlight(l) ? 150 : 40) - transfer);
}
export const flightUrl = (no: string) => `https://www.google.com/search?q=${encodeURIComponent(`${no} flight status`)}`;

function Who({ m, size = 28 }: { m: MemberT; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={avatarDataUrl(m.id, m.color)} alt="" width={size} height={size} className="shrink-0 rounded-full" />;
}

/** One line per member for the arrival / departure cards in the day view. */
export function TravelLines({ members, which, transfer }: { members: MemberT[]; which: "arrive" | "depart"; transfer?: number }) {
  const rows = members.map((m) => ({ m, l: m.travel?.[which] ?? null })).filter((r) => r.l && (r.l.time || r.l.flight))
    .sort((a, b) => (toMin(a.l!.time) ?? 1e9) - (toMin(b.l!.time) ?? 1e9));
  if (!rows.length) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {rows.map(({ m, l }) => (
        <li key={m.id} className="flex items-center gap-2 text-[13px]">
          <Who m={m} size={24} />
          <span className="min-w-0 flex-1 truncate"><b className="font-semibold">{m.name}</b>{l!.place ? ` · ${l!.place}` : ""}</span>
          {l!.flight && <a href={flightUrl(l!.flight)} target="_blank" rel="noreferrer" className="inline-flex h-10 shrink-0 items-center rounded-full bg-surface px-3 text-[12px] font-medium tnum underline-offset-2 hover:underline">{l!.flight}</a>}
          <span className="shrink-0 text-right tnum">
            <b className="font-semibold">{l!.time ?? "--:--"}</b>
            {which === "depart" && transfer != null && leaveBy(l, transfer) && <span className="block text-[11px] text-muted">ออกจากที่พัก {leaveBy(l, transfer)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LegForm({ title, hint, v, set }: { title: string; hint: string; v: TravelLeg; set: (l: TravelLeg) => void }) {
  const cls = "mt-1 h-11 w-full rounded-[14px] border border-line bg-surface px-3 text-[16px] text-ink";
  return (
    <fieldset className="rounded-[16px] border border-line p-3">
      <legend className="px-1 text-[14px] font-semibold">{title}</legend>
      <p className="text-[12px] text-muted">{hint}</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block text-[12px] text-muted">เวลา
          <input type="time" value={v.time ?? ""} onChange={(e) => set({ ...v, time: e.target.value || null })} className={`${cls} tnum`} />
        </label>
        <label className="block text-[12px] text-muted">เที่ยวบิน/ขบวน
          <input value={v.flight ?? ""} onChange={(e) => set({ ...v, flight: e.target.value.toUpperCase() || null })} placeholder="เช่น TG664" maxLength={12} autoCapitalize="characters" className={`${cls} tnum`} />
        </label>
      </div>
      <label className="mt-2 block text-[12px] text-muted">สนามบิน/สถานี
        <input value={v.place ?? ""} onChange={(e) => set({ ...v, place: e.target.value || null })} placeholder="เช่น สนามบินผู่ตง (PVG)" maxLength={80} className={cls} />
      </label>
    </fieldset>
  );
}

/** "เที่ยวบินและแยกย้าย": everyone's way in and out. Each member fills in their own; nothing is required. */
export default function TravelPanel({ tripId, token, me, members, hotel, hub, firstDay, lastDay, onSaved }: {
  tripId: string; token: string; me: string; members: MemberT[]; hotel: Place | null; hub: Place | null;
  firstDay: string | null; lastDay: string | null; onSaved: (t: Travel | null) => void;
}) {
  const mine = members.find((m) => m.id === me)?.travel ?? null;
  const blank: TravelLeg = { time: null, flight: null, place: null };
  const [arrive, setArrive] = useState<TravelLeg>(mine?.arrive ?? blank);
  const [depart, setDepart] = useState<TravelLeg>(mine?.depart ?? blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = JSON.stringify([arrive, depart]) !== JSON.stringify([mine?.arrive ?? blank, mine?.depart ?? blank]);
  const transfer = transferMin(hotel, hub);
  const others = members.filter((m) => m.id !== me);
  const filled = members.filter((m) => m.travel?.arrive || m.travel?.depart).length;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ travel: Travel | null }>(`/api/trips/${tripId}/travel`, { token, method: "PATCH", body: { arrive, depart } });
      onSaved(r.travel);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  }
  const myLeave = leaveBy(depart, transfer);

  return (
    <div className="space-y-5 pb-6">
      <p className="text-[14px] text-muted">ใส่ของตัวเองคนละครั้ง ไม่บังคับ ระบบจะใช้เวลานี้เริ่มวันแรกหลังเครื่องลง และบอกว่าวันสุดท้ายแต่ละคนต้องออกจากที่พักกี่โมง</p>
      <section className="space-y-3">
        <h3 className="text-[15px] font-semibold">ของฉัน</h3>
        <LegForm title="ขาไป" hint={firstDay ? `ถึงปลายทาง ${firstDay}` : "เวลาที่ถึงปลายทาง"} v={arrive} set={setArrive} />
        <LegForm title="ขากลับ" hint={lastDay ? `ออกเดินทาง ${lastDay}` : "เวลาที่เครื่อง/รถออก"} v={depart} set={setDepart} />
        {myLeave && (
          <p className="rounded-[14px] bg-lime px-3 py-2 text-[14px] text-ink" role="status">
            ควรออกจากที่พักไม่เกิน <b className="tnum">{myLeave}</b> <span className="text-[12px]">(เดินทางราว {transfer} นาที + ถึงก่อน {isFlight(depart) ? "2 ชม.ครึ่ง" : "40 นาที"})</span>
          </p>
        )}
        {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}
        <Button onClick={save} disabled={busy || !dirty} className="w-full">{busy ? "กำลังบันทึก…" : dirty ? "บันทึกการเดินทางของฉัน" : "บันทึกแล้ว"}</Button>
      </section>

      <section>
        <h3 className="text-[15px] font-semibold">ทั้งแก๊ง <span className="font-normal text-muted">กรอกแล้ว {filled} จาก {members.length} คน</span></h3>
        <ul className="mt-2 divide-y divide-line rounded-[16px] border border-line">
          {[...members.filter((m) => m.id === me), ...others].map((m) => {
            const t = m.travel;
            return (
              <li key={m.id} className="flex items-start gap-3 p-3">
                <Who m={m} size={32} />
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="text-[14px] font-semibold">{m.name}{m.id === me ? " (ฉัน)" : ""}</p>
                  {!t?.arrive && !t?.depart ? <p className="text-muted">ยังไม่ได้กรอก</p> : (
                    <>
                      {t?.arrive && <p className="tnum">ไป · ถึง {t.arrive.time ?? "--:--"}{t.arrive.flight ? <> · <a className="inline-flex min-h-10 items-center px-1 underline underline-offset-2" href={flightUrl(t.arrive.flight)} target="_blank" rel="noreferrer">{t.arrive.flight}<IconExternal size={11} className="ml-0.5 inline" /></a></> : ""}{t.arrive.place ? ` · ${t.arrive.place}` : ""}</p>}
                      {t?.depart && <p className="tnum">กลับ · ออก {t.depart.time ?? "--:--"}{t.depart.flight ? <> · <a className="inline-flex min-h-10 items-center px-1 underline underline-offset-2" href={flightUrl(t.depart.flight)} target="_blank" rel="noreferrer">{t.depart.flight}<IconExternal size={11} className="ml-0.5 inline" /></a></> : ""}{t.depart.place ? ` · ${t.depart.place}` : ""}
                        {leaveBy(t.depart, transfer) ? <span className="text-muted"> · ออกจากที่พัก {leaveBy(t.depart, transfer)}</span> : null}</p>}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {others.some((m) => !m.travel?.arrive && !m.travel?.depart) && <p className="mt-2 text-[12px] text-muted">เพื่อนเปิดทริปแล้วกด “เที่ยวบิน/แยกย้าย” เพื่อกรอกของตัวเองได้</p>}
      </section>
    </div>
  );
}

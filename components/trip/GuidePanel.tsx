"use client";
import { api } from "@/lib/client/api";
import { dayList, gmapsPlace } from "@/lib/client/util";
import { Button } from "@/components/ui/Field";
import { IconBed, IconBus, IconExternal, IconPlus, IconWand } from "@/components/icons";
import type { Place, Trip } from "@/lib/types";

const MODES: [string, string][] = [["transit", "รถไฟฟ้า/รถเมล์"], ["taxi", "แท็กซี่/Grab"], ["drive", "ขับรถเอง"], ["walk", "เดินเป็นหลัก"]];

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hotelLinks(q: string, checkIn: string | null, checkOut: string | null, adults: number) {
  const a = new URL("https://www.agoda.com/th-th/search");
  a.searchParams.set("textToSearch", q);
  const b = new URL("https://www.booking.com/searchresults.th.html");
  b.searchParams.set("ss", q);
  if (checkIn && checkOut) {
    a.searchParams.set("checkIn", checkIn); a.searchParams.set("checkOut", checkOut);
    b.searchParams.set("checkin", checkIn); b.searchParams.set("checkout", checkOut);
  }
  a.searchParams.set("adults", String(adults)); a.searchParams.set("rooms", "1");
  b.searchParams.set("group_adults", String(adults)); b.searchParams.set("no_rooms", "1");
  return { agoda: a.toString(), booking: b.toString() };
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[20px] bg-sunken p-4">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold"><span className="grid size-8 place-items-center rounded-full bg-surface">{icon}</span>{title}</h3>
      <div className="mt-2.5 text-[14px] leading-[22px]">{children}</div>
    </section>
  );
}

export default function GuidePanel({ trip, places, token, onPlan, onAddStay, onOpen, onChanged }: {
  trip: Trip; places: Place[]; token: string; onPlan: () => void; onAddStay: () => void; onOpen: (id: string) => void; onChanged: () => void;
}) {
  const g = trip.guide ?? {};
  const days = dayList(trip.start_date, trip.end_date);
  const stays = places.filter((p) => p.category === "stay").sort((a, b) => (a.day_index ?? 0) - (b.day_index ?? 0));
  const adults = trip.prefs?.travelers ?? 2;
  const mode = trip.prefs?.mode ?? "taxi";
  const whole = trip.destination && trip.start_date && trip.end_date ? hotelLinks(trip.destination, trip.start_date, trip.end_date, adults) : null;

  async function setMode(m: string) {
    await api(`/api/trips/${trip.id}`, { token, method: "PATCH", body: { prefs: { ...(trip.prefs ?? {}), mode: m } } });
    onChanged();
  }

  return (
    <div className="space-y-3 pb-6">
      {!g.summary && (
        <div className="rounded-[20px] bg-ink p-5 text-white">
          <p className="text-[17px] font-semibold">ยังไม่ได้จัดแผนอัตโนมัติ</p>
          <p className="mt-1 text-[14px] text-white/75">ให้ปักไปจัดวันเที่ยว ร้านกิน ที่พัก และวิธีเดินทางให้ครบในครั้งเดียว</p>
          <Button onClick={onPlan} className="mt-4 bg-lime text-ink hover:bg-lime/90"><IconWand size={16} />จัดทริปให้อัตโนมัติ</Button>
        </div>
      )}
      {g.summary && <p className="px-1 text-[15px] leading-6">{g.summary}</p>}

      <Section icon={<IconBed size={16} />} title={`ที่พัก${stays.length ? ` · ${stays.length} แห่ง` : ""}`}>
        {stays.length === 0 && <p className="text-muted">ยังไม่มีที่พัก เพิ่มเอง หรือให้ระบบจัดทริปจะหาที่พักใกล้แผนให้</p>}
        <ul className="space-y-2.5">
          {stays.map((s) => {
            const ci = s.day_index != null ? days[s.day_index] : null;
            const nights = s.details?.nights ?? 1;
            const checkIn = ci ? ci.date.toISOString().slice(0, 10) : trip.start_date;
            const checkOut = checkIn ? addDays(checkIn, nights) : null;
            const l = hotelLinks(`${s.name.replace(/\s*\(.*\)$/, "")} ${trip.destination ?? ""}`, checkIn, checkOut, adults);
            return (
              <li key={s.id} className="rounded-[16px] bg-surface p-3">
                <button onClick={() => onOpen(s.id)} className="block w-full text-left">
                  <span className="block font-semibold leading-6">{s.name}</span>
                  <span className="block text-[12px] text-muted">{ci ? `เช็กอิน ${ci.short} ${ci.num} ${ci.month} · ${nights} คืน` : "ยังไม่ระบุคืน"}{s.details?.why ? ` · ${s.details.why}` : ""}</span>
                </button>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <a href={l.agoda} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1 rounded-full border border-line px-3 text-[13px] font-medium hover:bg-sunken">Agoda <IconExternal size={13} /></a>
                  <a href={l.booking} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1 rounded-full border border-line px-3 text-[13px] font-medium hover:bg-sunken">Booking <IconExternal size={13} /></a>
                  <a href={gmapsPlace(s, trip.destination)} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1 rounded-full border border-line px-3 text-[13px] font-medium hover:bg-sunken">แผนที่ <IconExternal size={13} /></a>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onAddStay}><IconPlus size={16} />เพิ่มที่พัก</Button>
          {whole && <a href={whole.agoda} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-[14px] font-medium hover:bg-sunken">หาที่พักทั้งทริป <IconExternal size={14} /></a>}
        </div>
        <p className="mt-2 text-[12px] text-muted">ที่พักใช้เป็นจุดเริ่มและจุดกลับของแต่ละวันในแผนที่</p>
      </Section>

      <Section icon={<IconBus size={16} />} title="การเดินทาง">
        <div className="mb-3">
          <p className="mb-1.5 text-[12px] text-muted">เดินทางในเมืองด้วย (ใช้คำนวณเวลาในแผน)</p>
          <div className="grid grid-cols-2 gap-1.5">
            {MODES.map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} aria-pressed={mode === k}
                className={`h-10 rounded-full border text-[13px] font-medium ${mode === k ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}>{l}</button>
            ))}
          </div>
        </div>
        {g.getting_there ? (
          <>
            <p className="font-semibold">ไปถึงยังไง</p>
            <p className="mb-2 text-muted">{g.getting_there}</p>
            <p className="font-semibold">เที่ยวในเมือง</p>
            <p className="text-muted">{g.getting_around}</p>
          </>
        ) : <p className="text-muted">จัดทริปอัตโนมัติเพื่อรับคำแนะนำวิธีเดินทางจากไทยและในเมือง</p>}
      </Section>

      {g.tips && g.tips.length > 0 && (
        <Section icon={<span className="text-[13px] font-semibold">!</span>} title="ทริคก่อนไป">
          <ul className="list-disc space-y-1 pl-5 marker:text-muted">{g.tips.map((t) => <li key={t}>{t}</li>)}</ul>
        </Section>
      )}
      {g.summary && <Button variant="secondary" className="w-full" onClick={onPlan}><IconWand size={16} />จัดทริปใหม่อีกรอบ</Button>}
      <p className="px-1 text-[12px] text-muted">ข้อมูลจาก AI — ราคา เวลาเปิด และตารางรถควรเช็กอีกครั้งก่อนเดินทาง</p>
    </div>
  );
}

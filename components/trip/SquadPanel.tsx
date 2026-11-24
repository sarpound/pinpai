"use client";
import { useMemo } from "react";
import { avatarDataUrl } from "@/lib/client/avatar";
import { ago, fmtKm } from "@/lib/client/util";
import { MODES, MANUAL_MODES, MOVING, km, isMode, type Mode } from "@/lib/presence";
import { Button } from "@/components/ui/Field";
import { IconFlag, IconLocate, IconRoute } from "@/components/icons";
import type { Loc, MemberT, Place, Rally } from "@/lib/types";

const REACTIONS = ["👋", "❤️", "😂", "🔥", "🍜", "⏰"];

export function statusOf(l: Loc | undefined) {
  if (!l) return null;
  const m: Mode = isMode(l.mode) ? l.mode : "still";
  const fast = l.speed != null && MOVING.includes(m) && m !== "walk" && l.speed > 5 ? ` · ${Math.round(l.speed)} กม./ชม.` : "";
  return { mode: m, ...MODES[m], text: `${MODES[m].label}${fast}` };
}

export default function SquadPanel({ members, locations, me, rally, stays, sharing, armed, onToggleShare, onMode, onPing, onRallyHere, onRallyAt, onArm, onClearRally, onFocus, onAsk, onChat }: {
  members: MemberT[]; locations: Loc[]; me: string; rally: Rally | null; stays: Place[]; sharing: boolean; armed: boolean;
  onToggleShare: (on: boolean) => void; onMode: (m: Mode | "auto") => void; onPing: (to: string | null, emoji: string) => void;
  onRallyHere: () => void; onRallyAt: (p: { lat: number; lng: number; name: string }) => void; onArm: () => void; onClearRally: () => void; onFocus: (id: string) => void; onAsk?: (id: string) => void; onChat?: () => void;
}) {
  const loc = useMemo(() => new Map(locations.map((l) => [l.member_id, l])), [locations]);
  const mine = loc.get(me);
  const target = rally ?? (stays[0]?.lat != null ? { lat: stays[0].lat!, lng: stays[0].lng!, name: stays[0].name } : null);
  const arrived = members.filter((m) => {
    const l = loc.get(m.id);
    return l && (l.mode === "rally" || l.mode === "hotel" || (target && km(l, target) < 0.3));
  }).length;
  const mySt = statusOf(mine);
  const stay = stays.find((s) => s.lat != null);

  return (
    <div className="space-y-7 pb-6">
      {/* the scoreboard */}
      <section className="rounded-[20px] bg-ink p-4 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-white/70">{target ? `มาถึง${rally ? "จุดนัด" : "ที่พัก"}แล้ว` : "เปิดตำแหน่งอยู่"}</p>
            <p className="font-display text-[32px] font-semibold leading-10 tnum">
              {target ? arrived : locations.length}<span className="text-[18px] text-white/60">/{members.length} คน</span>
            </p>
          </div>
          <div className="flex -space-x-2">
            {members.slice(0, 5).map((m) => {
              const st = statusOf(loc.get(m.id));
              return (
                <span key={m.id} className="relative">
                  <img src={avatarDataUrl(m.id, m.color)} alt={m.name} className={`size-11 rounded-full border-2 border-ink ${loc.get(m.id) ? "" : "opacity-40 grayscale"}`} />
                  {st && <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-white text-[11px]" aria-hidden="true">{st.emoji}</span>}
                </span>
              );
            })}
          </div>
        </div>
        {target && (
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white/15" aria-hidden="true">
            <div className="h-full rounded-full bg-lime transition-[width] duration-700" style={{ width: `${(arrived / Math.max(1, members.length)) * 100}%` }} />
          </div>
        )}
        {target && <p className="mt-2 truncate text-[13px] text-white/80">{rally ? "🚩" : "🏨"} {target.name}</p>}
      </section>

      {/* me */}
      <section>
        <h3 className="text-[17px] font-semibold">สถานะของคุณ</h3>
        {!sharing ? (
          <>
            <p className="mt-1 text-[14px] text-muted">เปิดแล้วแก๊งจะเห็นตัวการ์ตูนของคุณบนแผนที่ พร้อมบอกว่ากำลังบิน นั่งรถ หรือถึงแล้ว ปิดเองใน 8 ชั่วโมง</p>
            <Button className="mt-3 w-full" onClick={() => onToggleShare(true)}><IconLocate size={18} />เปิดตำแหน่งให้แก๊งเห็น</Button>
          </>
        ) : (
          <>
            <p className="mt-1 text-[14px] text-muted">
              {mySt ? <>ตอนนี้: <b className="text-ink">{mySt.emoji} {mySt.text}</b>{mine?.manual ? " (ตั้งเอง)" : " (ระบบเดาให้)"}</> : "กำลังหาตำแหน่ง…"}
            </p>
            <div className="mt-3 grid grid-cols-5 gap-2" role="radiogroup" aria-label="เลือกสถานะ">
              <button type="button" role="radio" aria-checked={!mine?.manual} onClick={() => onMode("auto")}
                className={`flex h-16 flex-col items-center justify-center rounded-[16px] border text-[11px] font-medium ${!mine?.manual ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}>
                <span className="text-[20px] leading-6" aria-hidden="true">🪄</span>อัตโนมัติ
              </button>
              {MANUAL_MODES.map((m) => {
                const on = !!mine?.manual && mine.mode === m;
                return (
                  <button key={m} type="button" role="radio" aria-checked={on} onClick={() => onMode(m)}
                    className={`flex h-16 flex-col items-center justify-center rounded-[16px] border text-[11px] font-medium ${on ? "border-ink bg-ink text-white" : "border-line bg-surface"}`}>
                    <span className="text-[20px] leading-6" aria-hidden="true">{MODES[m].emoji}</span>{MODES[m].short}
                  </button>
                );
              })}
            </div>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => onToggleShare(false)}>หยุดแชร์ตำแหน่ง</Button>
          </>
        )}
      </section>

      {/* the gang */}
      <section>
        <h3 className="text-[17px] font-semibold">แก๊งอยู่ไหนกันบ้าง</h3>
        <ul className="mt-3 space-y-3">
          {members.filter((m) => m.id !== me).map((m) => {
            const l = loc.get(m.id), st = statusOf(l);
            const dMe = l && mine ? km(l, mine) : null;
            const dT = l && target ? km(l, target) : null;
            return (
              <li key={m.id} className="rounded-[20px] border border-line p-3">
                <div className="flex items-center gap-3">
                  <button onClick={() => l && onFocus(m.id)} disabled={!l} className="relative shrink-0" aria-label={l ? `ดู ${m.name} บนแผนที่` : m.name}>
                    <img src={avatarDataUrl(m.id, m.color)} alt="" className={`size-12 rounded-full ${l ? "" : "opacity-40 grayscale"}`} />
                    {st && <span className="absolute -right-1 -top-1 grid size-6 place-items-center rounded-full bg-white text-[13px] shadow" aria-hidden="true">{st.emoji}</span>}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold">{m.name}</p>
                    <p className="truncate text-[13px] text-muted">
                      {st ? <>{st.text} · {ago(l!.updated_at)}</> : "ยังไม่เปิดตำแหน่ง"}
                    </p>
                    {(dMe != null || dT != null) && (
                      <p className="truncate text-[12px] text-muted tnum">
                        {dMe != null && `ห่างคุณ ${fmtKm(dMe)}`}{dMe != null && dT != null && " · "}{dT != null && (dT < 0.3 ? `ถึง${rally ? "จุดนัด" : "ที่พัก"}แล้ว 🎉` : `อีก ${fmtKm(dT)} ถึง${rally ? "จุดนัด" : "ที่พัก"}`)}
                      </p>
                    )}
                  </div>
                  {l && (
                    <a href={`https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lng}`} target="_blank" rel="noreferrer"
                      className="grid size-10 shrink-0 place-items-center rounded-full bg-sunken hover:bg-line/60" aria-label={`นำทางไปหา ${m.name}`}><IconRoute size={18} /></a>
                  )}
                </div>
                {onAsk && (
                  <button onClick={() => onAsk(m.id)} className="mt-2.5 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-ink text-[14px] font-semibold text-white">
                    📍 {l ? "ขอตำแหน่งล่าสุด" : "ถามว่าอยู่ไหน"}
                  </button>
                )}
                <div className="mt-2 grid grid-cols-6 gap-1.5">
                  {(l ? REACTIONS : ["🥺"]).map((e) => (
                    <button key={e} onClick={() => onPing(m.id, e)} className={`h-10 rounded-full bg-sunken text-[18px] hover:bg-line/60 active:scale-90 transition-transform ${l ? "" : "col-span-6 text-[14px] font-medium"}`}
                      aria-label={l ? `ส่ง ${e} ให้ ${m.name}` : `สะกิด ${m.name} ให้เปิดตำแหน่ง`}>
                      {l ? e : "🥺 สะกิดให้เปิดตำแหน่ง"}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
          {members.length < 2 && <li className="rounded-[16px] border border-dashed border-line p-4 text-[14px] text-muted">ยังมีคุณคนเดียว ชวนเพื่อนเข้าทริปจากปุ่ม "ชวน" ด้านบน</li>}
        </ul>
      </section>

      {/* meeting point */}
      <section>
        <h3 className="flex items-center gap-2 text-[17px] font-semibold"><IconFlag size={18} />จุดนัดเจอ</h3>
        <p className="mt-1 text-[14px] text-muted">
          {rally ? <>🚩 <b className="text-ink">{rally.name}</b>{rally.by ? ` · ${rally.by} ปักไว้` : ""}{mine ? ` · ห่างคุณ ${fmtKm(km(mine, rally))}` : ""}</> : "ปักธงไว้ ทุกคนจะเห็นว่าห่างอีกเท่าไหร่ ใครมาถึงจะมีฉลองบนแผนที่"}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant={armed ? "primary" : "secondary"} size="sm" onClick={onArm}>{armed ? "แตะตรงไหนก็ได้บนแผนที่…" : "แตะเลือกบนแผนที่"}</Button>
          <Button variant="secondary" size="sm" onClick={onRallyHere} disabled={!sharing}>ปักที่ฉันอยู่</Button>
          {stay && <Button variant="secondary" size="sm" onClick={() => onRallyAt({ lat: stay.lat!, lng: stay.lng!, name: stay.name.replace(/\s*\(.*\)$/, "") })}>ปักที่ที่พัก</Button>}
          {rally && <Button variant="ghost" size="sm" onClick={onClearRally}>เอาธงออก</Button>}
        </div>
      </section>
    </div>
  );
}

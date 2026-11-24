"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { ago, fmtRange } from "@/lib/client/util";
import { avatarDataUrl } from "@/lib/client/avatar";
import { Button, Input, Label } from "@/components/ui/Field";
import { IconLink, IconLocate, IconShare } from "@/components/icons";
import type { Activity, Loc, MemberT, Trip } from "@/lib/types";

export default function PeoplePanel({ trip, members, locations, activity, me, token, sharing, onToggleShare, onChanged, toast }: {
  trip: Trip; members: MemberT[]; locations: Loc[]; activity: Activity[]; me: string; token: string;
  sharing: boolean; onToggleShare: (on: boolean) => void; onChanged: () => void; toast: (s: string) => void;
}) {
  const link = typeof window !== "undefined" ? `${location.origin}/join/${trip.invite_code}` : "";
  const msg = `มาวางแผน${trip.title}ด้วยกัน (${fmtRange(trip.start_date, trip.end_date)})`;
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ title: trip.title, destination: trip.destination ?? "", start_date: trip.start_date ?? "", end_date: trip.end_date ?? "" });
  const [err, setErr] = useState<string | null>(null);

  async function copy() {
    try { await navigator.clipboard.writeText(link); toast("คัดลอกลิงก์แล้ว"); } catch { toast(link); }
  }
  async function nativeShare() {
    if (navigator.share) { try { await navigator.share({ title: trip.title, text: msg, url: link }); } catch {} }
    else copy();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api(`/api/trips/${trip.id}`, { token, method: "PATCH", body: { ...f, start_date: f.start_date || null, end_date: f.end_date || null } }); setEdit(false); onChanged(); toast("บันทึกแล้ว"); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="space-y-7 pb-6">
      <section>
        <h3 className="text-[17px] font-semibold">ชวนเพื่อนมาวางแผน</h3>
        <p className="mt-1 text-[14px] text-muted">เพื่อนเปิดลิงก์ ใส่ชื่อเล่น แล้วแก้แผนด้วยกันได้ทันที ไม่ต้องสมัคร</p>
        <div className="mt-3 flex items-center gap-2 rounded-[16px] border border-line bg-sunken px-3 py-2.5">
          <IconLink size={16} />
          <span className="min-w-0 flex-1 truncate text-[14px] tnum">{link.replace(/^https?:\/\//, "")}</span>
          <button onClick={copy} className="-my-1.5 h-9 rounded-[8px] px-2 text-[14px] font-semibold text-accent hover:bg-accent-tint">คัดลอก</button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <a href={`https://line.me/R/share?text=${encodeURIComponent(`${msg}\n${link}`)}`} target="_blank" rel="noreferrer"
            className="inline-flex h-10 items-center justify-center rounded-full bg-[#06C755] text-[14px] font-semibold text-white hover:brightness-95">ส่งทาง LINE</a>
          <Button variant="secondary" size="sm" onClick={nativeShare}><IconShare size={16} />แชร์ช่องทางอื่น</Button>
        </div>
      </section>

      <section>
        <h3 className="text-[17px] font-semibold">ตำแหน่งระหว่างเที่ยว</h3>
        <p className="mt-1 text-[14px] text-muted">
          เปิดแล้วเพื่อนในทริปจะเห็นคุณบนแผนที่ ปิดเองอัตโนมัติใน 8 ชั่วโมง และจะอัปเดตเฉพาะตอนเปิดแอปค้างไว้
        </p>
        <Button className="mt-3 w-full" variant={sharing ? "secondary" : "primary"} onClick={() => onToggleShare(!sharing)}>
          <IconLocate size={18} />{sharing ? "หยุดแชร์ตำแหน่ง" : "แชร์ตำแหน่งให้เพื่อนเห็น"}
        </Button>
      </section>

      <section>
        <h3 className="text-[17px] font-semibold">คนในทริป · {members.length}</h3>
        <ul className="mt-2 divide-y divide-line">
          {members.map((m) => {
            const loc = locations.find((l) => l.member_id === m.id);
            return (
              <li key={m.id} className="flex items-center gap-3 py-2.5">
                <img src={avatarDataUrl(m.id, m.color)} alt="" className="size-11 rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.name}{m.id === me ? " (คุณ)" : ""}{m.role === "owner" ? <span className="text-muted"> · เจ้าของทริป</span> : null}</span>
                  <span className="block text-[12px] text-muted">{loc ? `แชร์ตำแหน่งอยู่ · อัปเดต${ago(loc.updated_at)}` : `เข้าล่าสุด${ago(m.last_seen)}`}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-[17px] font-semibold">ข้อมูลทริป</h3>
          {!edit && <Button variant="ghost" size="chip" onClick={() => setEdit(true)}>แก้ไข</Button>}
        </div>
        {edit ? (
          <form onSubmit={save} className="mt-3 space-y-3">
            <div><Label htmlFor="t-title">ชื่อทริป</Label><Input id="t-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} /></div>
            <div><Label htmlFor="t-dest">จุดหมาย</Label><Input id="t-dest" value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0"><Label htmlFor="t-s">วันไป</Label><Input id="t-s" type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></div>
              <div className="min-w-0"><Label htmlFor="t-e">วันกลับ</Label><Input id="t-e" type="date" value={f.end_date} min={f.start_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></div>
            </div>
            {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}
            <div className="flex gap-2"><Button type="submit" size="sm">บันทึก</Button><Button type="button" variant="secondary" size="sm" onClick={() => setEdit(false)}>ยกเลิก</Button></div>
          </form>
        ) : (
          <p className="mt-1 text-[14px] text-muted">{trip.destination ?? "ยังไม่ระบุจุดหมาย"} · {fmtRange(trip.start_date, trip.end_date)}</p>
        )}
      </section>

      {activity.length > 0 && (
        <section>
          <h3 className="text-[17px] font-semibold">ความเคลื่อนไหวล่าสุด</h3>
          <ul className="mt-2 space-y-1.5 text-[14px]">
            {activity.slice(0, 12).map((a) => (
              <li key={a.id} className="flex justify-between gap-3"><span className="min-w-0">{a.text}</span><span className="shrink-0 text-[12px] text-muted">{ago(a.created_at)}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

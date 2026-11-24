"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Input, Label, inputCls } from "@/components/ui/Field";
import { CandidateList } from "./shared";
import type { Candidate } from "@/lib/types";

const KINDS = [
  { v: "food", l: "ร้านอาหาร" },
  { v: "attraction", l: "ที่เที่ยว" },
  { v: "cafe", l: "คาเฟ่" },
  { v: "nightlife", l: "กลางคืน" },
] as const;

export default function RecommendPanel({ tripId, token, dayOptions, defaultDay, initialKind, onPreview, onDone }: {
  tripId: string; token: string; dayOptions: { value: number | null; label: string }[]; defaultDay: number | null;
  initialKind?: string; onPreview: (c: Candidate[]) => void; onDone: (msg: string) => void;
}) {
  const [kind, setKind] = useState<string>(initialKind ?? "food");
  const [note, setNote] = useState("");
  const [day, setDay] = useState<number | null>(defaultDay);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  async function run() {
    const fresh = !!items;
    setBusy(true); setErr(null); setItems(null); onPreview([]);
    try {
      const r = await api<{ places: Candidate[] }>(`/api/trips/${tripId}/recommend`, { token, body: { kind, note, day_index: day, fresh } });
      setItems(r.places);
      setPicked(new Set());
      onPreview(r.places);
      if (!r.places.length) setErr("ยังหาที่แนะนำไม่ได้ ลองเปลี่ยนหมวดดู");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function add() {
    if (!items) return;
    const list = items.filter((_, i) => picked.has(i)).map((c) => ({ name: c.name, category: c.category, lat: c.lat, lng: c.lng, address: c.address, day_index: day, source: "ai", details: { why: c.why, photo: c.photo ?? undefined } }));
    setBusy(true);
    try {
      const r = await api<{ added: number }>(`/api/trips/${tripId}/places/bulk`, { token, body: { places: list, label: "คำแนะนำ" } });
      onPreview([]);
      onDone(`เพิ่ม ${r.added} ที่ลงทริปแล้ว`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="หมวด" className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button key={k.v} role="radio" aria-checked={kind === k.v} onClick={() => setKind(k.v)}
            className={`h-9 rounded-full border px-3.5 text-[14px] font-medium ${kind === k.v ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink hover:bg-sunken"}`}>{k.l}</button>
        ))}
      </div>
      <div>
        <Label htmlFor="rec-day" hint="หาใกล้ๆ ที่ในวันนั้น">สำหรับ</Label>
        <select id="rec-day" value={day ?? ""} onChange={(e) => setDay(e.target.value === "" ? null : Number(e.target.value))} className={inputCls}>
          {dayOptions.map((o) => <option key={String(o.value)} value={o.value ?? ""}>{o.value == null ? "ทั้งทริป" : o.label}</option>)}
        </select>
      </div>
      <div>
        <Label htmlFor="rec-note" hint="ไม่ใส่ก็ได้">อยากได้แบบไหน</Label>
        <Input id="rec-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ไม่เผ็ด งบไม่เกิน 300 บาท วิวสวย" maxLength={200} />
      </div>
      <Button onClick={run} disabled={busy} variant={items ? "secondary" : "primary"} className="w-full">{busy && !items ? "กำลังหาที่แนะนำ…" : items ? "หาใหม่อีกชุด" : "ขอคำแนะนำ"}</Button>
      {busy && !items && <div className="space-y-2" aria-hidden>{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)}</div>}
      {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}
      {items && items.length > 0 && (
        <>
          <p className="text-[12px] text-muted">แนะนำโดย AI จากข้อมูลทั่วไป เช็กเวลาเปิดก่อนไปอีกครั้ง</p>
          <CandidateList items={items} picked={picked} onToggle={(i) => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
          <div className="sticky bottom-0 -mx-4 border-t border-line bg-surface px-4 py-3">
            <Button onClick={add} disabled={busy || picked.size === 0} className="w-full">{picked.size ? `เพิ่ม ${picked.size} ที่ลงทริป` : "เลือกที่อยากไปก่อน"}</Button>
          </div>
        </>
      )}
    </div>
  );
}

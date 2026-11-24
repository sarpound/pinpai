"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Input, Label, inputCls } from "@/components/ui/Field";
import { CandidateList } from "./shared";
import { IconImage, IconVideo, IconX } from "@/components/icons";
import type { Candidate, Place } from "@/lib/types";
import { defaultDur, toMin, toHHMM } from "./Suggest";

const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};

type ImportResult = { platform: string; author: string | null; places: Candidate[]; destination: string | null; source_url: string | null; caption: string };

async function shrinkImage(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

export default function ImportPanel({ tripId, token, initialUrl, dayOptions, defaultDay, onPreview, onDone, places = [], canPlan = false, prefs }: {
  tripId: string; token: string; initialUrl?: string | null; places?: Place[]; canPlan?: boolean; prefs?: Record<string, unknown>;
  dayOptions: { value: number | null; label: string }[]; defaultDay: number | null;
  onPreview: (c: Candidate[]) => void; onDone: (msg: string) => void;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [caption, setCaption] = useState("");
  const [showCaption, setShowCaption] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [day, setDay] = useState<number | null>(defaultDay);
  const [manual, setManual] = useState(false);
  const stops = places.filter((p) => p.day_index != null && p.category !== "stay" && p.lat != null && p.lng != null);
  const planned = stops.length > 0;
  const fileRef = useRef<HTMLInputElement>(null);
  const autoRan = useRef(false);

  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (initialUrl && !autoRan.current) { autoRan.current = true; run(); return; }
    // closed the app while a clip was being read? pick the result back up
    if (!initialUrl) api<{ result: ImportResult | null }>(`/api/trips/${tripId}/import`, { token }).then((r) => {
      if (r.result?.places?.length && !autoRan.current) { show(r.result); setResumed(true); if (r.result.source_url) setUrl(r.result.source_url); }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  function show(r: ImportResult) {
    setRes(r);
    // start with the sensible ones ticked: not already saved, not in another city
    setPicked(new Set(r.places.map((p, i) => (p.duplicate || p.far_km != null ? -1 : i)).filter((i) => i >= 0)));
    onPreview(r.places);
  }

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    setErr(null);
    if (!url.trim() && !caption.trim() && !image) return setErr("วางลิงก์คลิป แคปชัน หรือแนบภาพแคปหน้าจอก่อน");
    setBusy(true);
    setRes(null);
    onPreview([]);
    try {
      autoRan.current = true;
      setResumed(false);
      const r = await api<ImportResult>(`/api/trips/${tripId}/import`, { token, body: { url, caption, image } });
      show(r);
      if (!r.places.length) setErr("หาสถานที่ในคลิปนี้ไม่เจอ ลองวางแคปชันหรือแนบภาพแคปหน้าจอที่มีชื่อร้าน");
    } catch (e) {
      const m = (e as Error).message;
      setErr(m);
      if (/instagram|แคปชัน/i.test(m)) setShowCaption(true);
    } finally {
      setBusy(false);
    }
  }

  /** "manual" = the day picked in the dropdown; "nearest" = after the closest stop of any day; "plan" = wishlist, then plan the trip around them */
  async function add(how: "manual" | "nearest" | "plan") {
    if (!res) return;
    const days = new Set<number>();
    let far = 0, noLoc = 0;
    const list = res.places.filter((_, i) => picked.has(i)).map((c) => {
      const base = { name: c.name, category: c.category, lat: c.lat, lng: c.lng, address: c.address, source: "video", source_url: res.source_url, details: { why: c.why } };
      if (how === "plan") return { ...base, day_index: null };
      if (how === "manual") return { ...base, day_index: day };
      // nearest stop on any day (within ~25 km), else wishlist
      const near = c.lat != null && c.lng != null
        ? stops.map((s) => ({ s, d: kmBetween({ lat: c.lat!, lng: c.lng! }, { lat: s.lat!, lng: s.lng! }) })).sort((a, b) => a.d - b.d)[0] : null;
      if (!near || near.d > 25) { if (near) far++; else noLoc++; return { ...base, day_index: null }; }
      days.add(near.s.day_index!);
      // give it a time right after that stop when it fits before the next one
      const sameDay = places.filter((p) => p.day_index === near.s.day_index && p.category !== "stay").sort((a, b) => a.sort_order - b.sort_order);
      const next = sameDay[sameDay.indexOf(near.s) + 1];
      const st = toMin(near.s.start_time);
      const at = st != null ? Math.ceil((st + (near.s.duration_min ?? 60) + 10 + near.d * 3) / 5) * 5 : null;
      const dur = defaultDur(c.category);
      const fits = at != null && (toMin(next?.start_time) == null || at + dur + 10 <= toMin(next!.start_time)!) && at < 23 * 60;
      return { ...base, after_id: near.s.id, ...(fits ? { start_time: toHHMM(at!), duration_min: dur } : {}) };
    });
    setBusy(true);
    try {
      const r = await api<{ added: number }>(`/api/trips/${tripId}/places/bulk`, { token, body: { places: list, label: res.platform === "tiktok" ? "TikTok" : "คลิป" } });
      onPreview([]);
      if (how === "plan") {
        try {
          await api(`/api/trips/${tripId}/plan`, { token, body: { ...(prefs ?? {}) } });
          onDone(`เพิ่ม ${r.added} ที่แล้ว กำลังจัดทริปรอบๆ ที่เหล่านี้ให้ ปิดแอปได้ เดี๋ยวแผนขึ้นเอง`);
        } catch (e) { onDone(`เพิ่ม ${r.added} ที่ไว้ใน “รอจัด” แล้ว แต่ยังจัดทริปไม่ได้: ${(e as Error).message}`); }
      } else if (how === "nearest") {
        const ds = [...days].sort((a, b) => a - b).map((d) => d + 1);
        onDone(`เพิ่ม ${r.added} ที่${ds.length ? ` ลงวันที่ ${ds.join(", ")} ต่อจากที่ที่อยู่ใกล้สุด` : ""}${far + noLoc ? ` · อีก ${far + noLoc} ที่${noLoc && !far ? "ยังไม่รู้ตำแหน่ง" : far && !noLoc ? "ไกลจากแผน" : "ไกลหรือยังไม่รู้ตำแหน่ง"} เก็บไว้ใน “รอจัด”` : ""}`);
      } else onDone(`เพิ่ม ${r.added} ที่ลงทริปแล้ว${day == null ? " (อยู่ใน “รอจัด” กดจัดทริปอัตโนมัติให้ลงวันได้เลย)" : ""}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="space-y-3">
        <div>
          <Label htmlFor="imp-url">ลิงก์คลิปเที่ยว</Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"><IconVideo size={18} /></span>
            <Input id="imp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="วางลิงก์ TikTok, Reel, YouTube หรือ Google Maps" className="pl-10" inputMode="url" />
          </div>
        </div>
        {showCaption ? (
          <div>
            <Label htmlFor="imp-cap" hint="ช่วยให้แม่นขึ้น">แคปชันของคลิป</Label>
            <textarea id="imp-cap" value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} className={`${inputCls} h-auto py-2.5`} placeholder="คัดลอกแคปชันหรือรายชื่อร้านจากคลิปมาวาง" />
          </div>
        ) : (
          <button type="button" onClick={() => setShowCaption(true)} className="-ml-1 h-10 rounded-[8px] px-1 text-[14px] font-medium text-accent hover:bg-accent-tint">วางแคปชันเองแทน</button>
        )}
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImage(await shrinkImage(f)); e.target.value = ""; }} />
          {image ? (
            <span className="inline-flex items-center gap-2 rounded-[8px] border border-line bg-surface py-1 pl-1 pr-2 text-[14px]">
              <img src={image} alt="ภาพแคปหน้าจอที่แนบ" className="size-8 rounded-[6px] object-cover" />แนบภาพแล้ว
              <button type="button" onClick={() => setImage(null)} aria-label="เอาภาพออก" className="text-muted"><IconX size={16} /></button>
            </span>
          ) : (
            <Button type="button" variant="secondary" size="chip" onClick={() => fileRef.current?.click()}><IconImage size={16} />แนบภาพแคปหน้าจอ</Button>
          )}
        </div>
        <Button type="submit" disabled={busy} className="w-full">{busy && !res ? "กำลังอ่านคลิป…" : "ดึงสถานที่จากคลิป"}</Button>
        <p className="text-[12px] text-muted">TikTok, YouTube, Facebook และลิงก์ Google Maps ดึงได้อัตโนมัติ · Instagram / Xiaohongshu ที่ต้องล็อกอิน ให้วางแคปชันหรือแนบภาพแคปหน้าจอแทน · ถ้าชื่อร้านอยู่แค่ในเสียงพูดหรือในคลิป ให้แคปหน้าจอที่มีชื่อร้านแนบมา</p>
      </form>

      {busy && !res && (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-14" />)}
        </div>
      )}
      {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}

      {res && res.places.length > 0 && (
        <div className="space-y-3">
          <p className="text-[14px] text-muted">
            {resumed ? "ผลจากคลิปล่าสุดที่คุณวางไว้ · " : ""}เจอ {res.places.length} ที่{res.author ? ` จากคลิปของ ${res.author}` : ""} เลือกที่อยากเก็บไว้
          </p>
          {res.places.some((p) => p.duplicate || p.far_km != null) && (
            <p className="rounded-[12px] bg-sunken px-3 py-2 text-[13px] text-muted">ที่ที่มีในทริปแล้ว หรืออยู่ไกลจากจุดหมาย จะไม่ถูกติ๊กไว้ให้ ติ๊กเองได้ถ้าตั้งใจจะไป</p>
          )}
          <CandidateList items={res.places} picked={picked} onToggle={(i) => setPicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
          <div className="sticky bottom-0 -mx-4 space-y-2 border-t border-line bg-surface px-4 py-3">
            {manual ? (
              <div className="flex gap-2">
                <label htmlFor="imp-day" className="sr-only">ใส่ไว้ที่</label>
                <select id="imp-day" value={day ?? ""} onChange={(e) => setDay(e.target.value === "" ? null : Number(e.target.value))} className={`${inputCls} min-w-0 flex-1`}>
                  {dayOptions.map((o) => <option key={String(o.value)} value={o.value ?? ""}>{o.label}</option>)}
                </select>
                <Button onClick={() => add("manual")} disabled={busy || picked.size === 0} className="shrink-0">เพิ่ม {picked.size} ที่</Button>
              </div>
            ) : planned ? (
              <Button onClick={() => add("nearest")} disabled={busy || picked.size === 0} className="w-full">เพิ่ม {picked.size} ที่ เข้าวันที่ใกล้ที่สุด</Button>
            ) : canPlan ? (
              <Button onClick={() => add("plan")} disabled={busy || picked.size === 0} className="w-full">เพิ่ม {picked.size} ที่ แล้วจัดทริปรอบๆ ให้เลย</Button>
            ) : (
              <Button onClick={() => add("manual")} disabled={busy || picked.size === 0} className="w-full">เพิ่ม {picked.size} ที่ลงทริป</Button>
            )}
            <p className="text-center text-[12px] text-muted">
              {!manual && planned ? "ระบบจะแทรกแต่ละที่ต่อจากจุดที่ใกล้ที่สุดในแผน ไม่ลบหรือย้ายที่เดิม · " : !manual && canPlan ? "ระบบจะจัดทุกวันโดยใส่ที่จากคลิปให้ครบ · " : ""}
              <button type="button" onClick={() => setManual((m) => !m)} className="min-h-8 font-medium text-accent underline-offset-2 hover:underline">{manual ? "ให้ระบบเลือกวันให้" : "เลือกวันเอง"}</button>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

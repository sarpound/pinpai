"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { avatarDataUrl } from "@/lib/client/avatar";
import { fmtKm, navUrl } from "@/lib/client/util";
import { IconLocate, IconRoute } from "@/components/icons";
import { CatIcon } from "./shared";
import type { ChatMsg, MemberT, Place } from "@/lib/types";
import { pushState, enablePush, disablePush, type PushState } from "@/lib/client/push";

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayLabel = (iso: string) => {
  const d = new Date(iso), n = new Date();
  if (d.toDateString() === n.toDateString()) return "วันนี้";
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
};

/** "notify me when the app is closed" — one row, honest about what this phone can do */
export function PushToggle({ tripId, token, toast }: { tripId: string; token: string; toast: (t: string) => void }) {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setSt).catch(() => setSt("unsupported")); }, []);
  if (st == null || st === "unsupported") return null;
  const flip = async () => {
    setBusy(true);
    try {
      const n = st === "on" ? await disablePush(tripId, token) : await enablePush(tripId, token);
      setSt(n);
      toast(n === "on" ? "เปิดแจ้งเตือนแล้ว ลองดูว่ามีแจ้งเตือนทดสอบเด้งไหม" : n === "denied" ? "เครื่องนี้ปิดสิทธิ์แจ้งเตือนของเว็บนี้ไว้" : "ปิดแจ้งเตือนแล้ว");
    } catch (e) { toast((e as Error).message || "เปิดแจ้งเตือนไม่สำเร็จ"); }
    setBusy(false);
  };
  return (
    <div className="mb-3 flex items-center gap-3 rounded-[16px] bg-sunken px-3 py-2.5">
      <span className="text-[18px]" aria-hidden>🔔</span>
      <span className="min-w-0 flex-1 text-[13px]">
        <span className="block text-[14px] font-semibold">แจ้งเตือนตอนปิดแอป</span>
        <span className="block text-muted">
          {st === "needs-install" ? "บน iPhone ต้องเพิ่มเว็บนี้ลงหน้าจอโฮมก่อน: กดปุ่มแชร์ → “เพิ่มไปยังหน้าจอโฮม” แล้วเปิดจากไอคอนนั้น"
            : st === "denied" ? "เครื่องนี้บล็อกแจ้งเตือนของเว็บนี้อยู่ เปิดได้ในการตั้งค่าของเบราว์เซอร์"
            : st === "on" ? "เปิดอยู่ เพื่อนทักหรือถามหา เครื่องนี้จะเด้ง" : "ให้เครื่องนี้เด้งเมื่อเพื่อนทัก ถามว่าอยู่ไหน หรือจัดทริปเสร็จ"}
        </span>
      </span>
      {(st === "on" || st === "off") && (
        <button onClick={flip} disabled={busy} role="switch" aria-checked={st === "on"} aria-label="แจ้งเตือนตอนปิดแอป"
          className={`h-10 shrink-0 rounded-full px-4 text-[13px] font-semibold disabled:opacity-60 ${st === "on" ? "border border-line bg-surface" : "bg-ink text-white"}`}>{busy ? "…" : st === "on" ? "ปิด" : "เปิด"}</button>
      )}
    </div>
  );
}

/** one-shot GPS fix (no live sharing needed) */
export function locateOnce(): Promise<{ lat: number; lng: number }> {
  return new Promise((ok, fail) => {
    if (!("geolocation" in navigator)) return fail(new Error("เครื่องนี้ไม่รองรับการระบุตำแหน่ง"));
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => fail(new Error(e.code === 1 ? "ยังไม่ได้อนุญาตให้ใช้ตำแหน่ง เปิดสิทธิ์ตำแหน่งให้เว็บนี้ก่อน" : "หาตำแหน่งไม่เจอ ลองออกไปที่โล่งแล้วกดใหม่")),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

/**
 * Trip chat: text, "here I am" pins, shared stops and "where are you?" requests in one thread.
 * `incoming` are messages pushed by the live channel; everything else arrives by polling `head` (the newest id on the server).
 */
export default function ChatPanel({ tripId, token, me, members, places, head, incoming, myPos, onSent, onRead, onOpenPlace, onShowOnMap, toast }: {
  tripId: string; token: string; me: string; members: MemberT[]; places: Place[]; head: number; incoming: ChatMsg[];
  myPos: { lat: number; lng: number } | null; onSent: (m: ChatMsg) => void; onRead: (id: number) => void;
  onOpenPlace: (id: string) => void; onShowOnMap: (p: { lat: number; lng: number; name: string }) => void; toast: (t: string) => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const lastId = msgs?.length ? msgs[msgs.length - 1].id : 0;
  const merge = (add: ChatMsg[]) => setMsgs((cur) => {
    const map = new Map((cur ?? []).map((m) => [m.id, m]));
    for (const m of add) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  });

  useEffect(() => {
    let alive = true;
    api<{ messages: ChatMsg[] }>(`/api/trips/${tripId}/chat`, { token }).then((r) => alive && merge(r.messages)).catch((e) => alive && (setErr((e as Error).message), setMsgs([])));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);
  // server has something newer than we show → fetch just the tail
  useEffect(() => {
    if (msgs == null || head <= lastId) return;
    api<{ messages: ChatMsg[] }>(`/api/trips/${tripId}/chat?after=${lastId}`, { token }).then((r) => merge(r.messages)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head, msgs == null]);
  useEffect(() => { if (incoming.length) merge(incoming); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [incoming]);
  useEffect(() => { if (lastId) { onRead(lastId); end.current?.scrollIntoView({ block: "end" }); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lastId]);

  async function send(body: Record<string, unknown>, tag: string) {
    setBusy(tag); setErr(null);
    try {
      const r = await api<{ message: ChatMsg }>(`/api/trips/${tripId}/chat`, { token, body });
      merge([r.message]); onSent(r.message);
      return true;
    } catch (e) { setErr((e as Error).message); return false; } finally { setBusy(null); }
  }
  async function sendText() {
    const t = text.trim();
    if (!t) return;
    setText("");
    if (!(await send({ kind: "text", body: t }, "text"))) setText(t);
  }
  async function sendLoc() {
    setBusy("loc"); setErr(null);
    try {
      const p = myPos ?? (await locateOnce());
      await send({ kind: "loc", lat: p.lat, lng: p.lng }, "loc");
    } catch (e) { setErr((e as Error).message); setBusy(null); }
  }

  const who = (id: string | null) => members.find((m) => m.id === id);
  const others = members.filter((m) => m.id !== me);
  let prevDay = "";

  return (
    <div className="flex min-h-[50vh] flex-col">
      <PushToggle tripId={tripId} token={token} toast={toast} />
      <div className="flex-1 space-y-2 pb-3" aria-live="polite">
        {msgs == null && <p className="py-8 text-center text-[14px] text-muted">กำลังโหลดแชท…</p>}
        {msgs?.length === 0 && (
          <div className="rounded-[16px] bg-sunken p-4 text-[14px]">
            <p className="font-semibold">ยังไม่มีข้อความ</p>
            <p className="mt-1 text-muted">นัดเวลา ส่งตำแหน่งตัวเอง หรือถามเพื่อนว่าอยู่ไหน คุยกันได้ที่นี่ ทุกคนในทริปเห็นเหมือนกัน</p>
          </div>
        )}
        {msgs?.map((m) => {
          const mine = m.member_id === me, from = who(m.member_id);
          const day = dayLabel(m.created_at), showDay = day !== prevDay;
          prevDay = day;
          const place = m.place_id ? places.find((p) => p.id === m.place_id) : null;
          const target = m.kind === "locreq" ? who(m.to_member) : null;
          return (
            <div key={m.id}>
              {showDay && <p className="py-1 text-center text-[12px] text-muted">{day}</p>}
              <div className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : ""}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {!mine && <img src={avatarDataUrl(from?.id ?? "x", from?.color ?? "#999")} alt="" width={28} height={28} className="shrink-0 rounded-full" />}
                <div className={`max-w-[78%] ${mine ? "items-end" : "items-start"} flex flex-col`}>
                  {!mine && <span className="mb-0.5 px-1 text-[12px] text-muted">{from?.name ?? "เพื่อนที่ออกจากทริปแล้ว"}</span>}
                  {m.kind === "text" && <p className={`whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2 text-[15px] leading-[22px] ${mine ? "bg-ink text-white" : "bg-sunken"}`}>{m.body}</p>}
                  {m.kind === "loc" && m.lat != null && m.lng != null && (
                    <div className={`rounded-[18px] p-3 ${mine ? "bg-ink text-white" : "bg-sunken"}`}>
                      <p className="flex items-center gap-1.5 text-[14px] font-semibold"><IconLocate size={16} />{mine ? "ตำแหน่งของฉัน" : `${from?.name ?? "เพื่อน"} อยู่ตรงนี้`}</p>
                      {!mine && myPos && <p className={`text-[12px] ${mine ? "text-white/75" : "text-muted"}`}>ห่างจากคุณ {fmtKm(km(myPos, { lat: m.lat, lng: m.lng }))}</p>}
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => onShowOnMap({ lat: m.lat!, lng: m.lng!, name: from?.name ?? "เพื่อน" })} className={`h-10 rounded-full px-3.5 text-[13px] font-semibold ${mine ? "bg-white/15" : "bg-surface"}`}>ดูบนแผนที่</button>
                        {!mine && <a href={navUrl({ lat: m.lat, lng: m.lng, name: from?.name ?? "" })} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-full bg-lime px-3.5 text-[13px] font-semibold text-ink"><IconRoute size={15} />นำทางไปหา</a>}
                      </div>
                    </div>
                  )}
                  {m.kind === "place" && (
                    <button onClick={() => place && onOpenPlace(place.id)} disabled={!place} className={`flex items-center gap-2.5 rounded-[18px] p-3 text-left ${mine ? "bg-ink text-white" : "bg-sunken"}`}>
                      <span className={`grid size-10 shrink-0 place-items-center rounded-[12px] ${mine ? "bg-white/15" : "bg-surface"}`}><CatIcon category={place?.category ?? "other"} size={18} /></span>
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold">{place?.name ?? "สถานที่ที่ถูกลบไปแล้ว"}</span>
                        {place && <span className={`block text-[12px] ${mine ? "text-white/75" : "text-muted"}`}>{place.day_index != null ? `วันที่ ${place.day_index + 1}${place.start_time ? ` · ${place.start_time.slice(0, 5)}` : ""}` : "รอจัด"} · แตะเพื่อดู</span>}
                        {m.body && <span className="mt-1 block text-[14px]">{m.body}</span>}
                      </span>
                    </button>
                  )}
                  {m.kind === "locreq" && (
                    <p className="rounded-[18px] border border-dashed border-line px-3.5 py-2 text-[14px]">
                      📍 {mine ? `ขอตำแหน่งของ ${target?.name ?? "เพื่อน"} แล้ว` : m.to_member === me ? `${from?.name ?? "เพื่อน"} ถามว่าคุณอยู่ไหน` : `${from?.name ?? "เพื่อน"} ขอตำแหน่งของ ${target?.name ?? "เพื่อน"}`}
                    </p>
                  )}
                  <span className="mt-0.5 px-1 text-[11px] text-muted tnum">{clock(m.created_at)}</span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      <div className="sticky bottom-0 -mx-4 border-t border-line bg-surface px-4 pb-3 pt-2">
        {err && <p role="alert" className="mb-2 text-[13px] text-danger">{err}</p>}
        <div className="mb-2 flex gap-2 overflow-x-auto">
          <button onClick={sendLoc} disabled={!!busy} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-lime px-3.5 text-[13px] font-semibold text-ink disabled:opacity-60"><IconLocate size={15} />{busy === "loc" ? "กำลังหาตำแหน่ง…" : "ส่งตำแหน่งฉัน"}</button>
          {others.map((m) => (
            <button key={m.id} disabled={!!busy} onClick={async () => { if (await send({ kind: "locreq", to: m.id }, `req${m.id}`)) toast(`ถาม ${m.name} แล้วว่าอยู่ไหน`); }}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] font-medium disabled:opacity-60">📍 {m.name} อยู่ไหน</button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); sendText(); }} className="flex items-end gap-2">
          <label htmlFor="chat-text" className="sr-only">ข้อความ</label>
          <textarea id="chat-text" value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={1000} placeholder="พิมพ์ถึงทุกคนในทริป"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) { e.preventDefault(); sendText(); } }}
            className="max-h-28 min-h-11 flex-1 resize-none rounded-[22px] border border-line bg-surface px-4 py-2.5 text-[16px] leading-[22px]" />
          <button type="submit" disabled={!text.trim() || busy === "text"} className="h-11 shrink-0 rounded-full bg-ink px-4 text-[14px] font-semibold text-white disabled:opacity-40">ส่ง</button>
        </form>
      </div>
    </div>
  );
}

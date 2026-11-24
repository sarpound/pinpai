"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { api, getSessions, saveSession, forgetSession } from "@/lib/client/api";
import { CATEGORY, DAY_COLORS, NEUTRAL, dayList, fmtDur, fmtKm, fmtRange, gmapsDirections, inkOn, travel } from "@/lib/client/util";
import type { Candidate, DayRoute, Leg, Place, TripState, MemberT, ChatMsg } from "@/lib/types";
import type { MapFriend, MapPin, MapRoute, MapPop } from "@/components/MapView";
import { Button, Toast } from "@/components/ui/Field";
import { IconChevronRight, IconCar, IconChevronLeft, IconHeart, IconPlus, IconRoute, IconVideo, IconWalk, IconWand, IconUtensils, IconLocate, IconBed, IconBus, IconWallet } from "@/components/icons";
import { CatIcon } from "./shared";
import ImportPanel from "./ImportPanel";
import RecommendPanel from "./RecommendPanel";
import PlaceDetail from "./PlaceDetail";
import AddPanel from "./AddPanel";
import PeoplePanel from "./PeoplePanel";
import DaySelector from "./DaySelector";
import PlannerPanel from "./PlannerPanel";
import GuidePanel from "./GuidePanel";
import BudgetPanel from "./BudgetPanel";
import SquadPanel from "./SquadPanel";
import { MODES, MOVING, isMode, km, type Mode } from "@/lib/presence";
import { stayForDay } from "@/lib/client/stays";
import { DayView, WishView, AllView, PanelTitle, isToday } from "./DayViews";
import { avatarDataUrl } from "@/lib/client/avatar";
import { joinLive, type LivePos } from "@/lib/client/live";
import TravelPanel from "./TravelPanel";
import ChatPanel, { locateOnce } from "./ChatPanel";
import { syncPush } from "@/lib/client/push";
import { clearSuggestMemo, defaultDur, toHHMM, type PickFn } from "./Suggest";
import { dayStamp, bestSlots, type Warning, type RetimeCtx, type Calib } from "@/lib/retime";
import type { SlotPick } from "./AddPanel";
import DayEditor, { type DayExtra } from "./DayEditor";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false, loading: () => <div className="absolute inset-0 bg-[#E9ECE8]" /> });

type Tab = "wish" | "all" | number;
/** the time the whole group is there (latest arrival) / the first one has to leave (earliest departure) */
function groupTime(members: MemberT[], which: "arrive" | "depart") {
  const ts = members.map((m) => m.travel?.[which]?.time).filter((t): t is string => !!t).sort();
  return ts.length ? (which === "arrive" ? ts[ts.length - 1] : ts[0]) : null;
}
type View =
  | { kind: "list" }
  | { kind: "place"; id: string }
  | { kind: "import"; url?: string | null }
  | { kind: "recommend"; rec?: string }
  | { kind: "add" }
  | { kind: "people" }
  | { kind: "plan" }
  | { kind: "guide" }
  | { kind: "budget" }
  | { kind: "squad" }
  | { kind: "travel" }
  | { kind: "chat" };
type Snap = "peek" | "half" | "full";

function useDesktop() {
  const [d, setD] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const f = () => setD(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return d;
}

export default function TripApp({ tripId, importUrl, openPlan }: { tripId: string; importUrl?: string | null; openPlan?: boolean }) {
  const [session, setSession] = useState<{ token: string; memberId: string } | null | undefined>(undefined);
  const [data, setData] = useState<TripState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("wish");
  const [view, setView] = useState<View>(importUrl ? { kind: "import", url: importUrl } : openPlan ? { kind: "plan" } : { kind: "list" });
  const [preview, setPreview] = useState<{ name: string; lat: number | null; lng: number | null }[]>([]);
  const [snap, setSnap] = useState<Snap>(importUrl || openPlan ? "full" : "half");
  const [dragH, setDragH] = useState<number | null>(null);
  const [toast, setToastText] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [rallyArm, setRallyArm] = useState(false);
  const [focusFriend, setFocusFriend] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, LivePos>>({});
  const [myPos, setMyPos] = useState<LivePos | null>(null);
  const liveCh = useRef<ReturnType<typeof joinLive> | null>(null);
  // chat: newest id we know of (server poll or live push), newest id this phone has read, messages pushed live
  const [chatIn, setChatIn] = useState<ChatMsg[]>([]);
  const [chatHead, setChatHead] = useState(0);
  const [chatRead, setChatRead] = useState(0);
  const [reqSkip, setReqSkip] = useState(0);
  const [reqBusy, setReqBusy] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const lastCast = useRef<{ t: number; lat: number; lng: number } | null>(null);
  const lastMyPos = useRef(0);
  const [bursts, setBursts] = useState<MapPop[]>([]);
  const seenPing = useRef<Set<number> | null>(null);
  const prevMode = useRef<Map<string, string | null> | null>(null);
  const prevMembers = useRef<string[] | null>(null);
  const prevJob = useRef<import("@/lib/types").PlanJob | null>(null);
  const desktop = useDesktop();
  const [, setVh] = useState(0); // re-render sheet snap heights on rotate / browser-bar resize
  useEffect(() => { const f = () => setVh(window.innerHeight); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  const stampRef = useRef<string>("");
  const planningRef = useRef(false);
  const lastChange = useRef(Date.now());
  const tabInit = useRef(false);
  const watchId = useRef<number | null>(null);
  const lastSent = useRef(0);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  const reqSeq = useRef(0);
  const appliedSeq = useRef(0);

  const [toastAct, setToastAct] = useState<{ label: string; onClick: () => void } | null>(null);
  const toastMsg = useCallback((t: string) => {
    setToastText(t); setToastAct(null);
    window.setTimeout(() => setToastText((x) => (x === t ? null : x)), 2400);
  }, []);
  /** toast with an undo button, kept on screen a bit longer */
  const toastUndo = useCallback((t: string, undo: () => Promise<void>) => {
    setToastText(t);
    setToastAct({ label: "เลิกทำ", onClick: () => { setToastText(null); setToastAct(null); undo().catch(() => {}); } });
    window.setTimeout(() => setToastText((x) => { if (x === t) { setToastAct(null); return null; } return x; }), 6000);
  }, []);

  useEffect(() => {
    const s = getSessions()[tripId];
    setSession(s ? { token: s.token, memberId: s.memberId } : null);
  }, [tripId]);

  const load = useCallback(async (force = false) => {
    if (!session) return;
    const seq = ++reqSeq.current;
    try {
      const q = !force && stampRef.current ? `?v=${encodeURIComponent(stampRef.current)}` : "";
      const r = await api<TripState & { unchanged?: boolean }>(`/api/trips/${tripId}${q}`, { token: session.token });
      // a slower, older poll must not overwrite state from a newer request (e.g. refresh after an edit)
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      if (r.unchanged) { setLoadErr(null); return; }
      stampRef.current = r.stamp;
      lastChange.current = Date.now();
      setData(r);
      setLoadErr(null);
      saveSession(tripId, { token: session.token, memberId: session.memberId, title: r.trip.title, role: r.members?.find((m) => m.id === session.memberId)?.role });
    } catch (e) {
      if (seq < appliedSeq.current) return;
      const err = e as Error & { status?: number };
      if (err.status === 401 || err.status === 404) { forgetSession(tripId); setSession(null); }
      else setLoadErr("เน็ตหลุด เดี๋ยวลองใหม่ให้อัตโนมัติ");
    }
  }, [session, tripId]);

  useEffect(() => {
    if (!session) return;
    load(true);
    // adaptive polling: 4s while the group is active (recent edits / someone sharing location), 15s when quiet
    let t = 0, stop = false;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") await load();
      const busy = Date.now() - lastChange.current < 120_000 || watchId.current != null || planningRef.current;
      t = window.setTimeout(tick, busy ? 4000 : 15000);
    };
    t = window.setTimeout(tick, 4000);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { stop = true; window.clearTimeout(t); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [session, load]);

  const refresh = useCallback(() => load(true), [load]);
  refreshRef.current = refresh;
  useEffect(() => { if (session) syncPush(tripId, session.token); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tripId, session?.token]);
  useEffect(() => { try { setChatRead(Number(localStorage.getItem(`pinpai.chatread.${tripId}`)) || 0); } catch {} }, [tripId]);
  useEffect(() => { if (data?.chat?.last) setChatHead((h) => Math.max(h, data.chat!.last)); }, [data?.chat?.last]);
  const markRead = useCallback((id: number) => {
    setChatRead((r) => { const n = Math.max(r, id); try { localStorage.setItem(`pinpai.chatread.${tripId}`, String(n)); } catch {} return n; });
  }, [tripId]);

  const days = useMemo(() => (data ? dayList(data.trip.start_date, data.trip.end_date) : []), [data?.trip.start_date, data?.trip.end_date]);
  const me = data?.members.find((m) => m.id === data.me);

  // pick a sensible first tab once
  useEffect(() => {
    if (!data || tabInit.current) return;
    tabInit.current = true;
    if (days.length && data.places.some((p) => p.day_index != null)) {
      const now = new Date(); // local calendar date (UTC would be "yesterday" before 7am in Thailand)
      const todayIdx = days.findIndex((d) => d.date.getUTCFullYear() === now.getFullYear() && d.date.getUTCMonth() === now.getMonth() && d.date.getUTCDate() === now.getDate());
      setTab(todayIdx >= 0 ? todayIdx : 0);
    }
  }, [data, days]);

  // my sharing state from server
  useEffect(() => {
    if (!me) return;
    const active = me.share_location && (!me.share_until || new Date(me.share_until) > new Date());
    if (active && watchId.current == null) startWatch();
    if (!active && watchId.current != null) stopWatch();
    setSharing(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.share_location, me?.share_until]);

  function startWatch() {
    if (!navigator.geolocation || !session || watchId.current != null) return;
    watchId.current = navigator.geolocation.watchPosition(async (pos) => {
      const now = Date.now(), c = pos.coords;
      const p: LivePos = { m: session.memberId, lat: c.latitude, lng: c.longitude, h: c.heading ?? null, s: c.speed ?? null, t: now };
      // my own avatar follows the phone's GPS right away
      if (now - lastMyPos.current > 800) { lastMyPos.current = now; setMyPos(p); }
      const prev = lastCast.current;
      const movedM = prev ? km(prev, p) * 1000 : Infinity;
      const moving = (c.speed ?? 0) > 0.7 || movedM > 15;
      // live to the gang: every ~2s while moving, every 15s when still (peer-to-peer, nothing stored)
      if (!prev || (moving && now - prev.t > 2000) || now - prev.t > 15000) {
        lastCast.current = { t: now, lat: p.lat, lng: p.lng };
        liveCh.current?.send(p);
      }
      // the server copy (history, travel-mode detection): every 10s moving / 30s still
      if (now - lastSent.current < (moving ? 10000 : 30000)) return;
      lastSent.current = now;
      try {
        await api(`/api/trips/${tripId}/location`, { token: session.token, body: { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
          speed: c.speed, heading: c.heading } });
      } catch (e) { if ((e as { status?: number }).status === 409) { stopWatch(); setSharing(false); } }
    }, () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => { wakeLock.current = l; }).catch(() => {});
  }
  // subscribe to the trip's live channel
  useEffect(() => {
    if (!data?.live) return;
    const ch = joinLive(data.live, (p) => setLive((cur) => (cur[p.m] && cur[p.m].t >= p.t ? cur : { ...cur, [p.m]: p })), (m) => {
      const msg = m as ChatMsg;
      if (!msg || typeof msg.id !== "number") return;
      setChatIn((cur) => (cur.some((x) => x.id === msg.id) ? cur : [...cur.slice(-50), msg]));
      setChatHead((h) => Math.max(h, msg.id));
      if (msg.kind === "locreq") refreshRef.current();
    });
    liveCh.current = ch;
    return () => { ch.leave(); liveCh.current = null; };
  }, [data?.live]);

  function stopWatch() {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setMyPos(null);
    wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
  }
  useEffect(() => () => stopWatch(), []);

  async function toggleShare(on: boolean) {
    if (!session) return;
    if (on) {
      if (!navigator.geolocation) return toastMsg("เบราว์เซอร์นี้แชร์ตำแหน่งไม่ได้");
      navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
          await api(`/api/trips/${tripId}/location`, { token: session.token, body: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, hours: 8 } });
          lastSent.current = Date.now();
          setSharing(true);
          startWatch();
          toastMsg("เพื่อนเห็นตำแหน่งคุณแล้ว");
          refresh();
        } catch (e) { toastMsg((e as Error).message); }
      }, () => toastMsg("ยังไม่ได้อนุญาตให้ใช้ตำแหน่ง เปิดได้ที่การตั้งค่าเบราว์เซอร์"), { enableHighAccuracy: true, timeout: 15000 });
    } else {
      stopWatch();
      setSharing(false);
      await api(`/api/trips/${tripId}/location`, { token: session.token, method: "DELETE" }).catch(() => {});
      toastMsg("หยุดแชร์ตำแหน่งแล้ว");
      refresh();
    }
  }

  function here(): Promise<GeolocationPosition> {
    return new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }));
  }
  async function setMode(m: Mode | "auto") {
    if (!session) return;
    try {
      const pos = await here();
      await api(`/api/trips/${tripId}/location`, { token: session.token, body: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, mode: m } });
      lastSent.current = Date.now();
      toastMsg(m === "auto" ? "ให้ระบบเดาสถานะให้แล้ว" : `${MODES[m].emoji} ${MODES[m].label}`);
      refresh();
    } catch (e) { toastMsg((e as Error).message || "หาตำแหน่งไม่เจอ ลองใหม่อีกที"); }
  }
  async function ping(to: string | null, emoji: string) {
    if (!session) return;
    try { await api(`/api/trips/${tripId}/ping`, { token: session.token, body: { to, emoji } }); toastMsg(`ส่ง ${emoji} แล้ว`); refresh(); }
    catch (e) { toastMsg((e as Error).message); }
  }
  // a friend wrote while I'm looking at something else → small toast (the 💬 button shows the dot)
  const toasted = useRef(0);
  useEffect(() => {
    const m = chatIn[chatIn.length - 1];
    if (!m || !data || m.id <= toasted.current || m.member_id === data.me || view.kind === "chat") return;
    toasted.current = m.id;
    const name = data.members.find((x) => x.id === m.member_id)?.name ?? "เพื่อน";
    toastMsg(m.kind === "text" ? `${name}: ${(m.body ?? "").slice(0, 60)}` : m.kind === "loc" ? `${name} ส่งตำแหน่งมาในแชท` : m.kind === "place" ? `${name} ส่งสถานที่มาในแชท` : m.to_member === data.me ? `${name} ถามว่าคุณอยู่ไหน` : `${name} ถามหาเพื่อนในแชท`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatIn]);
  /** post to the trip chat and push it to everyone who has the trip open */
  async function chatPost(body: Record<string, unknown>) {
    if (!session) return null;
    const r = await api<{ message: ChatMsg }>(`/api/trips/${tripId}/chat`, { token: session.token, body });
    liveCh.current?.chat(r.message);
    setChatIn((cur) => [...cur.slice(-50), r.message]);
    setChatHead((h) => Math.max(h, r.message.id));
    return r.message;
  }
  async function askWhere(id: string) {
    const m = data?.members.find((x) => x.id === id);
    try { await chatPost({ kind: "locreq", to: id }); toastMsg(`ถาม ${m?.name ?? "เพื่อน"} แล้วว่าอยู่ไหน ตอบเมื่อไหร่จะขึ้นในแชท`); }
    catch (e) { toastMsg((e as Error).message); }
  }
  /** answer "where are you?" with one GPS fix — no need to turn live sharing on */
  async function answerWhere() {
    setReqBusy(true);
    try {
      const p = myPos ?? (await locateOnce());
      await chatPost({ kind: "loc", lat: p.lat, lng: p.lng });
      if (data?.chat?.locreq) setReqSkip(data.chat.locreq.id);
      toastMsg("ส่งตำแหน่งให้เพื่อนแล้ว");
      refresh();
    } catch (e) { toastMsg((e as Error).message); }
    setReqBusy(false);
  }
  async function setRally(r: { lat: number; lng: number; name?: string } | null) {
    if (!session) return;
    setRallyArm(false);
    try {
      await api(`/api/trips/${tripId}`, { token: session.token, method: "PATCH", body: { prefs: { rally: r ? { ...r, name: r.name ?? "จุดนัดเจอ" } : null } } });
      toastMsg(r ? "ปักธงจุดนัดแล้ว 🚩" : "เอาธงออกแล้ว");
      refresh();
    } catch (e) { toastMsg((e as Error).message); }
  }
  async function rallyHere() {
    try { const pos = await here(); setRally({ lat: pos.coords.latitude, lng: pos.coords.longitude, name: `ตรงที่${me?.name ?? ""}อยู่` }); }
    catch { toastMsg("หาตำแหน่งไม่เจอ ลองใหม่อีกที"); }
  }

  // ---------- derived ----------
  const byDay = useMemo(() => {
    const m = new Map<number, Place[]>();
    data?.places.forEach((p) => { if (p.day_index != null && p.category !== "stay") { const a = m.get(p.day_index) ?? []; a.push(p); m.set(p.day_index, a); } });
    m.forEach((a) => a.sort((x, y) => x.sort_order - y.sort_order));
    return m;
  }, [data?.places]);
  const wish = useMemo(() => (data?.places.filter((p) => p.day_index == null && p.category !== "stay") ?? []).sort((a, b) => b.votes.length - a.votes.length), [data?.places]);
  const stays = useMemo(() => data?.places.filter((p) => p.category === "stay") ?? [], [data?.places]);
  const hotelFor = (d: number) => stayForDay(stays.filter((s) => s.lat != null) as (Place & { lat: number; lng: number })[], d);

  // road route of the active day (hotel → stops → hotel), refetched when that day's stops change
  const [dayRoute, setDayRoute] = useState<DayRoute | null>(null);
  // edit mode for one day; while dragging, the map follows the editor's order (straight lines until saved)
  const [editing, setEditing] = useState<number | null>(null);
  const [editOrder, setEditOrder] = useState<string[] | null>(null);
  const routeSig = typeof tab === "number" ? `${tab}|${(byDay.get(tab) ?? []).map((p) => `${p.id}${p.lat}${p.sort_order}`).join(",")}|${stays.map((s) => s.id + s.day_index).join(",")}|${data?.trip.prefs?.mode}` : "";
  useEffect(() => {
    if (!session || typeof tab !== "number") { setDayRoute(null); return; }
    let live = true;
    api<DayRoute>(`/api/trips/${tripId}/route-day?day=${tab}`, { token: session.token }).then((r) => { if (live) setDayRoute(r); }).catch(() => live && setDayRoute(null));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSig]);

  // fill in Wikipedia photos in the background (free; batches of 12)
  const photoRuns = useRef(0);
  const [photoTick, setPhotoTick] = useState(0);
  const needPhotos = data?.places.some((p) => !p.details?.photo_checked || ((p.details as { approx?: boolean; geo_checked?: boolean }).approx && !(p.details as { geo_checked?: boolean }).geo_checked && p.lat != null)) ?? false;
  useEffect(() => {
    if (!session || !needPhotos || photoRuns.current > 14) return;
    photoRuns.current++;
    const t = setTimeout(() => {
      api<{ updated: number; remaining: number }>(`/api/trips/${tripId}/photos`, { token: session.token, body: {} })
        .then((r) => { if (r.updated || r.remaining) refresh(); if (r.remaining) setPhotoTick((n) => n + 1); }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needPhotos, data?.places.length, photoTick]);
  const dayColor = (i: number) => days[i]?.color ?? DAY_COLORS[i % 7] ?? NEUTRAL;
  const dayOptions = useMemo(() => [{ value: null as number | null, label: "ยังไม่ลงวัน" }, ...days.map((d) => ({ value: d.index as number | null, label: `วัน ${d.index + 1} · ${d.short} ${d.num} ${d.month}` }))], [days]);

  const pins: MapPin[] = useMemo(() => {
    if (!data) return [];
    const out: MapPin[] = [];
    const ordered = (list: Place[], di: number) => (editing === di && editOrder
      ? editOrder.map((id) => list.find((p) => p.id === id)).filter((p): p is Place => !!p) : list);
    byDay.forEach((list0, di) => ordered(list0, di).forEach((p, i) => {
      if (p.lat == null || p.lng == null) return;
      // one day at a time: other days' stops stay off the map so routes never pile up ("ทั้งทริป" shows them all)
      if (typeof tab === "number" && tab !== di) return;
      const active = tab !== "wish";
      out.push({ id: p.id, lat: p.lat, lng: p.lng, color: dayColor(di), ink: inkOn(dayColor(di)), label: String(i + 1), kind: "stop", title: `วัน ${di + 1} · ${p.name}`,
        dim: !active, name: typeof tab === "number" && tab === di ? p.name : undefined });
    }));
    wish.forEach((p) => { if (p.lat != null && p.lng != null) out.push({ id: p.id, lat: p.lat, lng: p.lng, color: null, label: "", kind: "wish", title: p.name }); });
    stays.forEach((p) => { if (p.lat != null && p.lng != null) out.push({ id: p.id, lat: p.lat, lng: p.lng, color: null, label: "", kind: "stay", title: `ที่พัก · ${p.name}` }); });
    preview.forEach((c, i) => { if (c.lat != null && c.lng != null) out.push({ id: `cand-${i}`, lat: c.lat, lng: c.lng, color: null, label: "", kind: "cand", title: c.name }); });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, byDay, wish, stays, preview, days, tab, editing, editOrder]);

  const routes: MapRoute[] = useMemo(() => {
    const out: MapRoute[] = [];
    if (tab === "wish") return out;
    byDay.forEach((list, di) => {
      if (typeof tab === "number" && di !== tab) return;
      if (di === tab && editing === di && editOrder) {
        const ids = editOrder.map((id) => list.find((p) => p.id === id)).filter((p): p is Place => !!p && p.lat != null);
        out.push({ id: `d${di}`, color: dayColor(di), coords: ids.map((p) => [p.lng!, p.lat!]) });
      } else if (di === tab && dayRoute?.geometry && dayRoute.geometry.length > 1) out.push({ id: `d${di}`, color: dayColor(di), coords: dayRoute.geometry });
      else out.push({ id: `d${di}`, color: dayColor(di), coords: list.filter((p) => p.lat != null).map((p) => [p.lng!, p.lat!]) });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byDay, tab, days, dayRoute, editing, editOrder]);

  // everyone sharing their location, including me, drawn as cartoon avatars
  const friends: MapFriend[] = useMemo(() => (data?.locations ?? []).map((l) => {
    const m = data!.members.find((x) => x.id === l.member_id);
    const mode = isMode(l.mode) ? l.mode : null;
    // freshest position wins: my phone's GPS → live broadcast → last saved copy
    const lp = l.member_id === data?.me && myPos ? myPos : live[l.member_id];
    const fresh = lp && lp.t > new Date(l.updated_at).getTime() ? lp : null;
    const at = fresh ? fresh.t : new Date(l.updated_at).getTime();
    const stale = Date.now() - at > 10 * 60_000;
    return { id: l.member_id, lat: fresh?.lat ?? l.lat, lng: fresh?.lng ?? l.lng, color: m?.color ?? NEUTRAL, initial: (m?.name ?? "?").slice(0, 1), name: m?.name ?? "",
      stale, me: l.member_id === data?.me, badge: mode ? MODES[mode].emoji : undefined, moving: !stale && !!mode && MOVING.includes(mode),
      heading: fresh?.h ?? l.heading, plane: mode === "plane", trail: (l.trail ?? []).map((t) => [t.lng, t.lat] as [number, number]), mini: view.kind !== "squad" };
  }), [data, view.kind, live, myPos]);

  // reactions from the gang + arrival celebrations
  useEffect(() => {
    if (!data) return;
    const fresh = !seenPing.current;
    seenPing.current ??= new Set();
    const name = (id: string | null) => data.members.find((m) => m.id === id)?.name ?? "เพื่อน";
    for (const p of data.pings ?? []) {
      if (seenPing.current.has(p.id)) continue;
      seenPing.current.add(p.id);
      if (!fresh && p.to_member === data.me && p.from_member !== data.me) toastMsg(`${name(p.from_member)} ส่ง ${p.emoji} มาให้คุณ`);
    }
    const prev = prevMode.current;
    const next = new Map(data.locations.map((l) => [l.member_id, l.mode]));
    if (prev) for (const l of data.locations) {
      const was = prev.get(l.member_id);
      if ((l.mode === "hotel" || l.mode === "rally") && was !== l.mode) {
        setBursts((b) => [...b.slice(-10), { key: `arr${l.member_id}${Date.now()}`, memberId: l.member_id, emoji: "🎉", burst: true }]);
        toastMsg(`${l.member_id === data.me ? "คุณ" : name(l.member_id)} ${MODES[l.mode as Mode].label} 🎉`);
      }
    }
    prevMode.current = next;
    // background planner finished (for whoever pressed it, and for the friends watching)
    const job = data.trip.plan_job;
    const was = prevJob.current;
    if (was && was.state === "running" && job && job.started_at === was.started_at && job.state !== "running") {
      if (job.state === "done") {
        const one = job.only_day;
        toastMsg(one != null ? `จัดวันที่ ${one + 1} ใหม่แล้ว 🎉 (${(job.added ?? 0) + (job.moved ?? 0)} ที่)` : `จัดทริป ${job.days ?? ""} วันเสร็จแล้ว 🎉 (${(job.added ?? 0) + (job.moved ?? 0)} ที่) ปรับต่อได้ตามใจ`);
        setTab(one ?? 0); photoRuns.current = 0;
        setView((v) => (v.kind === "plan" ? { kind: "list" } : v));
        if (!desktop) setSnap("half");
      } else toastMsg(job.message ?? "จัดทริปไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
    prevJob.current = job ?? null;
    // someone new joined → say hi with confetti over the header crowd
    const ids = data.members.map((m) => m.id);
    if (prevMembers.current) for (const m of data.members) if (!prevMembers.current.includes(m.id) && m.id !== data.me) toastMsg(`${m.name} เข้าร่วมทริปแล้ว 🎉 ชวนเปิดตำแหน่งได้ที่ "แก๊งอยู่ไหน"`);
    prevMembers.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.pings, data?.locations, data?.members, data?.trip.plan_job]);
  const pops: MapPop[] = useMemo(() => [
    ...(data?.pings ?? []).filter((p) => Date.now() - new Date(p.created_at).getTime() < 45_000).map((p) => ({ key: `p${p.id}`, memberId: p.from_member, emoji: p.emoji })),
    ...bursts,
  ], [data?.pings, bursts]);
  const rally = data?.trip.prefs?.rally ?? null;
  const planJob = data?.trip.plan_job;
  const planning = planJob?.state === "running" && Date.now() - Date.parse(planJob.started_at) < 6 * 60_000;
  planningRef.current = !!planning;

  const focus = useMemo(() => {
    const ff = view.kind === "squad" && focusFriend ? friends.find((f) => f.id === focusFriend) : null;
    if (ff) return [{ lat: ff.lat, lng: ff.lng }];
    if (view.kind === "squad" && (friends.length || rally)) return [...friends, ...(rally ? [rally] : [])].map((f) => ({ lat: f.lat, lng: f.lng }));
    if (preview.some((c) => c.lat != null)) return preview.filter((c) => c.lat != null).map((c) => ({ lat: c.lat!, lng: c.lng! }));
    const list = tab === "wish" ? wish : tab === "all" ? [...byDay.values()].flat() : [...(byDay.get(tab) ?? []), ...(byDay.get(tab)?.length ? [hotelFor(tab)].filter(Boolean) as Place[] : [])];
    return list.filter((p) => p.lat != null).map((p) => ({ lat: p.lat!, lng: p.lng! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, wish, byDay, preview, stays, view.kind, friends.length, rally?.lat, focusFriend]);
  const fitKey = `${tab}|${focus.length}|${preview.length}${preview[0]?.lat ?? ""}|${view.kind === "squad" ? `squad${focusFriend ?? ""}` : ""}`;

  const selectedId = view.kind === "place" ? view.id : null;
  const selected = selectedId ? data?.places.find((p) => p.id === selectedId) ?? null : null;
  useEffect(() => { if (view.kind === "place" && data && !selected) setView({ kind: "list" }); }, [view, data, selected]);

  function openPlace(id: string) {
    if (id.startsWith("cand-")) return;
    pushPanel();
    setView({ kind: "place", id });
    const p = data?.places.find((x) => x.id === id);
    if (p) setTab(p.day_index ?? "wish");
    if (!desktop && snap === "peek") setSnap("half");
  }
  // phone/browser Back closes the open panel instead of leaving the trip
  const panelPushed = useRef(false);
  function pushPanel() {
    if (panelPushed.current) return;
    try { history.pushState({ ppPanel: true }, ""); panelPushed.current = true; } catch {}
  }
  function closePanel() {
    if (panelPushed.current) { history.back(); return; } // popstate below does the closing
    setPreview([]); setView({ kind: "list" }); if (!desktop) setSnap("half");
  }
  useEffect(() => {
    const onPop = () => {
      if (!panelPushed.current) return;
      panelPushed.current = false;
      setPreview([]); setView({ kind: "list" }); setRallyArm(false);
      if (!desktop) setSnap("half");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [desktop]);
  // a panel opened straight from a link (?plan=1 / ?import=) also gets a Back step
  useEffect(() => { if (view.kind !== "list") pushPanel(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function go(v: View) {
    setPreview([]);
    if (v.kind !== "list") pushPanel();
    setView(v);
    if (v.kind === "squad") setFocusFriend(null);
    if (!desktop && v.kind !== "list" && v.kind !== "place") setSnap(v.kind === "squad" ? "half" : "full");
  }
  /** where a stop sits in its day (for ‹ › in the place page) + the road leg to the next stop when we have it */
  function seqOf(p: Place) {
    if (p.day_index == null || p.category === "stay") return null;
    const list = byDay.get(p.day_index) ?? [];
    const i = list.findIndex((x) => x.id === p.id);
    if (i < 0) return null;
    let legNext: Leg | undefined;
    if (p.day_index === tab && dayRoute && Array.isArray(dayRoute.stopIds) && p.lat != null) {
      const k = dayRoute.stopIds.indexOf(p.id), nx = list[i + 1];
      const off = dayRoute.hotel && (dayRoute.hotelStart ?? true) ? 1 : 0;
      if (k >= 0 && nx && dayRoute.stopIds[k + 1] === nx.id) legNext = dayRoute.legs[k + off];
    }
    return { day: p.day_index, n: i + 1, total: list.length, prev: list[i - 1] ?? null, next: list[i + 1] ?? null, legNext, color: dayColor(p.day_index) };
  }

  /** one tap on a suggestion: put it in the slot (time + position), never touching what's already planned */
  const pickSuggestion: PickFn = async (o, ctx) => {
    if (!session || !data) return;
    const step = (m: number) => Math.ceil(m / 5) * 5;
    let at: number | null = ctx.from != null ? step(ctx.from + o.min) : ctx.minAt ?? null;
    if (at != null && ctx.minAt != null) at = Math.max(at, ctx.minAt);
    let dur = defaultDur(o.category);
    if (at != null && ctx.until != null) dur = Math.max(30, Math.min(dur, ctx.until - at - o.min));
    if (at != null && at > 23 * 60 + 30) at = null;
    const sort = ctx.after ? ctx.after.sort_order + 5 : ctx.first ? ctx.first.sort_order - 5 : undefined;
    const where = ctx.day == null ? "รายการรอจัด " : `วันที่ ${ctx.day + 1}${at != null ? ` เวลา ${toHHMM(at)}` : ""} `;
    try {
      if (o.wish_id) {
        const wid = o.wish_id;
        await api(`/api/trips/${tripId}/places/${wid}`, { token: session.token, method: "PATCH",
          body: { day_index: ctx.day, ...(sort != null ? { sort_order: sort } : {}), ...(at != null ? { start_time: toHHMM(at), duration_min: dur } : {}) } });
        toastUndo(`ย้าย ${o.name} ไป${where}แล้ว`, async () => {
          await api(`/api/trips/${tripId}/places/${wid}`, { token: session.token, method: "PATCH", body: { day_index: null, start_time: null } });
          clearSuggestMemo(); refresh();
        });
      } else {
        const r = await api<{ id: string }>(`/api/trips/${tripId}/places`, { token: session.token, body: {
          name: o.name, category: o.category, lat: o.lat, lng: o.lng, address: o.address, source: "ai", details: { why: o.why ?? undefined, photo: o.photo ?? undefined },
          day_index: ctx.day, ...(ctx.after ? { after_id: ctx.after.id } : sort != null ? { sort_order: sort } : {}),
          ...(at != null && ctx.day != null ? { start_time: toHHMM(at), duration_min: dur } : {}) } });
        toastUndo(`เพิ่ม ${o.name} ลง${where}แล้ว`, async () => {
          await api(`/api/trips/${tripId}/places/${r.id}`, { token: session.token, method: "DELETE" });
          clearSuggestMemo(); refresh();
        });
      }
      clearSuggestMemo();
      refresh();
    } catch (e) { toastMsg((e as Error).message); throw e; }
  };

  async function replanDay(day: number) {
    if (!session) return;
    try {
      await api(`/api/trips/${tripId}/plan`, { token: session.token, body: { only_day: day } });
      toastMsg(`กำลังจัดวันที่ ${day + 1} ให้ใหม่ ปิดแอปได้ เดี๋ยวแผนขึ้นเอง`);
      clearSuggestMemo();
      refresh();
    } catch (e) { toastMsg((e as Error).message); }
  }

  function done(msg: string) {
    toastMsg(msg);
    setPreview([]);
    setView({ kind: "list" });
    if (!desktop) setSnap("half");
    refresh();
  }

  // every row of a day (hotels included) in display order — the server checks the whole day as one unit
  const dayRows = (d: number) => (data?.places ?? []).filter((x) => x.day_index === d).sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
  type DayEdit = { start_time?: string | null; duration_min?: number | null; fixed?: boolean; user_dur?: boolean };

  // what the timetable needs to know about a day: travel mode, and on the last day when to leave for the airport
  const dayCtx = (d: number): RetimeCtx => {
    const nDays = days.length, prefs = data?.trip.prefs;
    const HH = /^([01]\d|2[0-3]):[0-5]\d$/;
    const dep = (prefs?.depart_time && HH.test(prefs.depart_time) ? prefs.depart_time : null)
      ?? (data?.members.map((m) => m.travel?.depart?.time).filter((t): t is string => !!t && HH.test(t)).sort()[0] ?? null);
    const endBy = nDays > 1 && d === nDays - 1 && dep ? Math.max(480, Number(dep.slice(0, 2)) * 60 + Number(dep.slice(3, 5)) - 150) : null;
    return { mode: prefs?.mode ?? null, endBy, calib: (prefs as { calib?: Calib } | undefined)?.calib ?? null };
  };

  /** the 3 best spots in a day for a new stop, with the request body that puts it there */
  const slotsFor = (d: number, cand: { name: string; category: string; lat: number; lng: number }): SlotPick[] => {
    const rows = dayRows(d), stops = rows.filter((x) => x.category !== "stay");
    if (!stops.length) return [];
    const toR = (x: Place) => ({ id: x.id, name: x.name, category: x.category, lat: x.lat, lng: x.lng, start_time: x.start_time, duration_min: x.duration_min,
      fixed: !!x.details?.fixed_time && !!x.start_time, userDur: !!x.details?.user_dur, visited: x.visited });
    return bestSlots(stops.map(toR), { ...cand, duration_min: null }, dayCtx(d)).map((sl) => ({
      ...sl, body: sl.after_id ? { after_id: sl.after_id } : { sort_order: stops[0].sort_order - 1 } }));
  };

  /** save a day's order + edits in one request; the server re-times the stops after it, and the toast offers undo */
  async function saveDay(d: number, order: string[], msg: string, edits: Record<string, DayEdit> = {}, retime = true, baseStamp?: string, extra?: DayExtra): Promise<boolean> {
    if (!session) return false;
    const rows = dayRows(d);
    const before = { order: rows.map((r) => r.id), edits: Object.fromEntries(rows.map((r) => [r.id,
      { start_time: r.start_time ? r.start_time.slice(0, 5) : null, duration_min: r.duration_min, fixed: !!r.details?.fixed_time, user_dur: !!r.details?.user_dur }])) };
    try {
      const r = await api<{ stamp: string; warnings: Warning[] }>(`/api/trips/${tripId}/days/${d}`, { token: session.token, method: "PUT",
        body: { stamp: baseStamp ?? dayStamp(rows), order, edits, retime, ...(extra ?? {}) } });
      await refresh();
      const w = r.warnings.filter((x) => x.kind === "late" || x.kind === "leave");
      const name = (id: string) => data?.places.find((x) => x.id === id)?.name ?? "";
      toastUndo(w.length ? `${msg} · ⚠️ ${name(w[0].id)} ${w[0].msg}${w.length > 1 ? ` (+${w.length - 1})` : ""}` : msg, async () => {
        await api(`/api/trips/${tripId}/days/${d}`, { token: session.token, method: "PUT", body: { stamp: r.stamp, order: before.order, edits: before.edits, retime: false, restore: true,
          times: Object.fromEntries(rows.map((x) => [x.id, { start_time: x.start_time ? x.start_time.slice(0, 5) : null, duration_min: x.duration_min }])) } });
        refresh();
      });
      return true;
    } catch (e) {
      toastMsg((e as Error).message);
      if ((e as { status?: number }).status === 409) refresh();
      return false;
    }
  }

  async function move(p: Place, dir: -1 | 1) {
    if (p.day_index == null) return;
    const rows = dayRows(p.day_index);
    const stops = rows.filter((x) => x.category !== "stay");
    const i = stops.findIndex((x) => x.id === p.id), j = i + dir;
    if (i < 0 || j < 0 || j >= stops.length) return;
    // swap with the neighbouring stop; hotels keep their slot
    const ids = rows.map((x) => x.id);
    const a = ids.indexOf(p.id), b = ids.indexOf(stops[j].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    await saveDay(p.day_index, ids, "เลื่อนแล้ว เวลาจุดอื่นขยับตาม");
  }

  /** set (or clear) a stop's start time; a time someone types is locked so the re-timing flows around it */
  async function setTime(p: Place, time: string | null, lock = true) {
    if (p.day_index == null) return;
    await saveDay(p.day_index, dayRows(p.day_index).map((x) => x.id), time ? `ตั้ง ${p.name} ${time} แล้ว จุดถัดไปขยับตาม` : "ล้างเวลาแล้ว",
      { [p.id]: { start_time: time, fixed: !!time && lock } });
  }

  async function sortByTime(list: Place[]) {
    const d = list[0]?.day_index;
    if (d == null) return;
    const rows = dayRows(d);
    const t = (x: Place) => (x.category === "stay" ? "" : x.start_time ?? "99");
    const order = [...rows].sort((a, b) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : a.sort_order - b.sort_order)).map((x) => x.id);
    await saveDay(d, order, "เรียงตามเวลาแล้ว", {}, false);
  }

  async function autoplan() {
    if (!session) return;
    try {
      const r = await api<{ moved: number }>(`/api/trips/${tripId}/autoplan`, { token: session.token, body: {} });
      toastMsg(`จัด ${r.moved} ที่ลงแต่ละวันแล้ว ปรับต่อได้ตามใจ`);
      await refresh();
      setTab(0);
    } catch (e) { toastMsg((e as Error).message); }
  }

  // ---------- sheet (mobile) ----------
  const peekH = 164;
  const snapPx = (s: Snap) => (typeof window === "undefined" ? 400 : s === "peek" ? peekH : s === "half" ? Math.round(window.innerHeight * 0.52) : window.innerHeight - 56);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  function onDown(e: React.PointerEvent) {
    if (desktop) return;
    drag.current = { y: e.clientY, h: snapPx(snap) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setDragH(Math.max(peekH - 20, Math.min(window.innerHeight - 40, drag.current.h - (e.clientY - drag.current.y))));
  }
  function onUp(e: React.PointerEvent) {
    if (!drag.current) return;
    const moved = Math.abs(e.clientY - drag.current.y);
    const h = dragH ?? drag.current.h;
    drag.current = null;
    setDragH(null);
    if (moved < 6) { setSnap(snap === "peek" ? "half" : snap === "half" ? "full" : "half"); return; }
    const opts: Snap[] = ["peek", "half", "full"];
    setSnap(opts.reduce((best, s) => (Math.abs(snapPx(s) - h) < Math.abs(snapPx(best) - h) ? s : best), "half"));
  }

  // ---------- render ----------
  if (session === undefined) return <div className="fixed inset-0 bg-sunken" />;
  if (session === null) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col justify-center px-5">
        <h1 className="text-[20px] font-semibold">ยังไม่ได้เข้าทริปนี้ในเครื่องนี้</h1>
        <p className="mt-1 text-muted">ขอลิงก์เชิญจากเพื่อนในทริป แล้วเปิดลิงก์นั้นเพื่อเข้าร่วม</p>
        <Link href="/" className="mt-5 inline-flex h-12 items-center justify-center rounded-full bg-ink px-6 font-semibold text-white">ไปหน้าแรก</Link>
      </main>
    );
  }

  const sheetH = desktop ? undefined : dragH ?? snapPx(snap);
  const mapPad = desktop ? { top: 110, bottom: 60, left: (typeof window !== "undefined" && window.innerWidth >= 1024 ? 416 : 396) + 40, right: 80 } : { top: 110, bottom: Math.min(snapPx(snap), (typeof window !== "undefined" ? window.innerHeight : 800) * 0.6) + 20, left: 36, right: 60 };
  const activeList = typeof tab === "number" ? byDay.get(tab) ?? [] : [];
  const dayHotel = typeof tab === "number" ? hotelFor(tab) : null;
  const multi = days.length > 1;
  const dirUrl = typeof tab === "number" ? gmapsDirections(dayHotel && activeList.length
    ? [...(multi && tab === 0 ? [] : [dayHotel]), ...activeList, ...(multi && tab === days.length - 1 ? [] : [dayHotel])] : activeList, data?.trip.prefs?.mode) : null;

  return (
    <div className="fixed inset-0 overflow-hidden bg-sunken">
      <div className="absolute inset-0 z-0">
        {data && (
          <MapView pins={pins} friends={friends} routes={routes} selectedId={selectedId} onSelect={(id) => (id ? openPlace(id) : view.kind === "place" && setView({ kind: "list" }))}
            center={data.trip.dest_lat != null ? { lat: data.trip.dest_lat, lng: data.trip.dest_lng! } : null} fitKey={fitKey} focus={focus} padding={mapPad}
            pops={pops} rally={rally} onFriend={(id) => { go({ kind: "squad" }); setFocusFriend(id); }}
            onMapClick={rallyArm ? (ll) => setRally({ ...ll, name: "จุดนัดเจอ" }) : undefined} />
        )}
        {/* squad pill: who's out there, what they're doing */}
        {data && (
          <div className="absolute left-3 z-10 flex items-center gap-2 md:left-[412px] lg:left-[432px]" style={{ top: "max(10px, env(safe-area-inset-top))" }}>
          <button onClick={() => go({ kind: "squad" })} className="inline-flex h-11 items-center gap-2 rounded-full bg-surface py-1 pl-1 pr-4 text-[14px] font-semibold text-ink shadow-[var(--shadow-2)]"
            aria-label="ดูว่าแก๊งอยู่ไหน">
            <span className="flex -space-x-2">
              {(friends.length ? friends : data.members.slice(0, 1).map((m) => ({ id: m.id, color: m.color, badge: undefined as string | undefined }))).slice(0, 4).map((f) => (
                <span key={f.id} className="relative">
                  <img src={avatarDataUrl(f.id, f.color)} alt="" className={`size-9 rounded-full border-2 border-white ${friends.length ? "" : "grayscale"}`} />
                  {f.badge && <span className="absolute -right-1 -top-1 text-[12px] leading-none" aria-hidden="true">{f.badge}</span>}
                </span>
              ))}
            </span>
            {friends.length ? <span>แก๊ง {friends.length}/{data.members.length}{sharing && <span className="ml-1.5 inline-block size-2 animate-pulse rounded-full bg-accent align-middle" />}</span> : "แก๊งอยู่ไหน?"}
          </button>
          <button onClick={() => go({ kind: "chat" })} className="relative inline-flex h-11 items-center gap-1.5 rounded-full bg-surface px-3.5 text-[14px] font-semibold text-ink shadow-[var(--shadow-2)]"
            aria-label={chatHead > chatRead ? "แชททริป มีข้อความใหม่" : "แชททริป"}>
            <span aria-hidden>💬</span>แชท
            {chatHead > chatRead && view.kind !== "chat" && <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-white bg-accent" />}
          </button>
          </div>
        )}
        {data?.chat?.locreq && data.chat.locreq.id > reqSkip && (
          <div className="absolute inset-x-3 z-20 mx-auto flex max-w-[420px] items-center gap-2 rounded-[18px] bg-ink p-2.5 pl-4 text-white shadow-[var(--shadow-2)] md:left-[412px]" style={{ top: "max(64px, calc(env(safe-area-inset-top) + 56px))" }} role="alert">
            <span className="min-w-0 flex-1 text-[14px] font-semibold">📍 {data.members.find((m) => m.id === data.chat!.locreq!.member_id)?.name ?? "เพื่อน"} ถามว่าคุณอยู่ไหน</span>
            <button onClick={answerWhere} disabled={reqBusy} className="h-10 shrink-0 rounded-full bg-lime px-3.5 text-[13px] font-semibold text-ink disabled:opacity-60">{reqBusy ? "กำลังหา…" : "ส่งตำแหน่ง"}</button>
            <button onClick={() => setReqSkip(data.chat!.locreq!.id)} className="h-10 shrink-0 rounded-full px-2.5 text-[13px] text-white/80">ไว้ก่อน</button>
          </div>
        )}
        {rallyArm && (
          <div className="absolute inset-x-0 z-10 mx-auto w-fit rounded-full bg-ink px-4 py-2 text-[14px] font-semibold text-white shadow-[var(--shadow-2)]" style={{ top: "max(64px, calc(env(safe-area-inset-top) + 56px))" }} role="status">
            🚩 แตะบนแผนที่ตรงที่จะนัดเจอ <button onClick={() => setRallyArm(false)} className="ml-2 underline">ยกเลิก</button>
          </div>
        )}
      </div>

      <aside
        className={`absolute inset-x-0 bottom-0 z-20 flex flex-col overflow-hidden rounded-t-[24px] bg-surface shadow-[var(--shadow-2)] md:inset-y-4 md:left-4 md:right-auto md:w-[380px] md:rounded-[24px] md:border md:border-line lg:w-[400px] ${dragH == null ? "transition-[height] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]" : ""}`}
        style={{ height: sheetH }}
        aria-label="แผนทริป"
      >
        {/* header: grabber + title + tabs (drag area on mobile) */}
        <div className="shrink-0 touch-none select-none md:touch-auto" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="flex justify-center pt-2 md:hidden"><span className="h-1 w-10 rounded-full bg-line" /></div>
          <div className="flex items-start gap-2 px-4 pb-2 pt-2 md:pt-4">
            <Link href="/" className="-ml-1 mt-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-sunken text-ink hover:bg-line/60" aria-label="กลับหน้าแรก" onPointerDown={(e) => e.stopPropagation()}><IconChevronLeft /></Link>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-display text-[20px] font-semibold leading-7 md:line-clamp-2 md:whitespace-normal">{data?.trip.title ?? "…"}</h1>
              <p className="truncate text-[12px] text-muted">{data ? fmtRange(data.trip.start_date, data.trip.end_date) : ""}</p>
            </div>
            {data && (
              <button onClick={() => go({ kind: "budget" })} onPointerDown={(e) => e.stopPropagation()} className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-sunken text-ink hover:bg-line/60" aria-label="งบและค่าใช้จ่าย">
                <IconWallet size={19} />
              </button>
            )}
            {data && (
              <button onClick={() => go({ kind: "people" })} onPointerDown={(e) => e.stopPropagation()} className="flex items-center rounded-full py-1 pl-1 pr-2 hover:bg-sunken" aria-label={`คนในทริป ${data.members.length} คน และชวนเพื่อน`}>
                <span className="flex -space-x-2">
                  {data.members.slice(0, 3).map((m) => <img key={m.id} src={avatarDataUrl(m.id, m.color)} alt={m.name} className="size-8 rounded-full border-2 border-white" />)}
                </span>
                <span className="ml-2 rounded-full bg-lime px-2.5 py-1 text-[13px] font-semibold text-ink">ชวน</span>
              </button>
            )}
          </div>
          {data && (
            <div onPointerDown={(e) => e.stopPropagation()}>
              <DaySelector days={days} tab={tab} wishCount={wish.length} counts={new Map([...byDay].map(([k, v]) => [k, v.length]))}
                onChange={(t) => { setTab(t); setView({ kind: "list" }); setPreview([]); }} />
            </div>
          )}
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-4 pt-3" style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
          onTouchStart={(e) => { swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
          onTouchEnd={(e) => {
            const s0 = swipe.current; swipe.current = null;
            if (!s0 || view.kind !== "list" || !days.length) return;
            const dx = e.changedTouches[0].clientX - s0.x, dy = e.changedTouches[0].clientY - s0.y;
            if (Math.abs(dx) < 70 || Math.abs(dy) > 45) return;
            const order: Tab[] = ["all", "wish", ...days.map((d) => d.index)];
            const at = order.indexOf(tab);
            const next = order[at + (dx < 0 ? 1 : -1)];
            if (next !== undefined) setTab(next);
          }}>
          {!data ? (
            <div className="space-y-3 pt-2" aria-label="กำลังโหลด">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)}</div>
          ) : view.kind !== "list" ? (
            <div>
              <button onClick={closePanel} className="-ml-1 mb-2 inline-flex h-10 items-center gap-1 rounded-full bg-sunken pl-2 pr-4 text-[14px] font-medium text-ink hover:bg-line/60">
                <IconChevronLeft size={18} />กลับไปที่แผน
              </button>
              {view.kind === "place" && selected && (
                <PlaceDetail place={selected} tripId={tripId} token={session.token} me={data.me} members={data.members} dayOptions={dayOptions}
                  destination={data.trip.destination} onSuggest={pickSuggestion} onShare={async () => { try { await chatPost({ kind: "place", place_id: selected.id }); toastMsg("ส่งเข้าแชททริปแล้ว"); } catch (e) { toastMsg((e as Error).message); } }} seq={seqOf(selected)} onGo={(pid) => setView({ kind: "place", id: pid })} onChanged={refresh} onDeleted={() => { setView({ kind: "list" }); refresh(); toastMsg("ลบแล้ว"); }} onMove={(d) => move(selected, d)} onTime={(t, lock) => setTime(selected, t, lock)} onInfo={toastMsg} />
              )}
              {view.kind === "import" && (
                <><PanelTitle title="ดึงที่เที่ยวจากคลิป" sub="วางลิงก์คลิปที่เพื่อนส่งมา ระบบจะหาชื่อร้านและสถานที่ แล้วให้คุณเลือกก่อนเพิ่ม" />
                <ImportPanel tripId={tripId} token={session.token} initialUrl={view.url} places={data.places} prefs={data.trip.prefs as Record<string, unknown>}
                  canPlan={!!data.trip.start_date && !!data.trip.end_date && !!data.trip.destination && !planning} dayOptions={dayOptions} defaultDay={typeof tab === "number" ? tab : null} onPreview={setPreview} onDone={done} /></>
              )}
              {view.kind === "recommend" && (
                <><PanelTitle title="แนะนำที่น่าไป" sub={`จากจุดหมาย ${data.trip.destination ?? ""} เลือกเฉพาะที่ชอบแล้วค่อยเพิ่ม`} />
                <RecommendPanel tripId={tripId} token={session.token} dayOptions={dayOptions} defaultDay={typeof tab === "number" ? tab : null} initialKind={view.rec} onPreview={setPreview} onDone={done} /></>
              )}
              {view.kind === "add" && (
                <><PanelTitle title="เพิ่มสถานที่" />
                <AddPanel tripId={tripId} token={session.token} near={focus[0] ?? (data.trip.dest_lat != null ? { lat: data.trip.dest_lat, lng: data.trip.dest_lng! } : null)}
                  dayOptions={dayOptions} defaultDay={typeof tab === "number" ? tab : null} onPreview={(h) => setPreview(h)} onDone={(m) => { toastMsg(m); refresh(); }} slotsFor={slotsFor} /></>
              )}
              {view.kind === "plan" && (
                <><PanelTitle title="จัดทริปให้อัตโนมัติ" sub={`เลือกสไตล์แค่ไม่กี่อย่าง แล้วปักไปจะจัดที่เที่ยว ร้านกิน ที่พัก และวิธีเดินทางให้ครบ ${days.length || ""} วัน`} />
                <PlannerPanel tripId={tripId} token={session.token} prefs={{ ...(data.trip.prefs ?? {}), arrive_time: data.trip.prefs?.arrive_time ?? groupTime(data.members, "arrive"), depart_time: data.trip.prefs?.depart_time ?? groupTime(data.members, "depart") }} job={data.trip.plan_job} hasDates={days.length > 0} hasPlaces={data.places.length > 0}
                  onNeedDates={() => go({ kind: "people" })} onStarted={() => { lastChange.current = Date.now(); refresh(); }} onBack={closePanel} /></>
              )}
              {view.kind === "guide" && (
                <><PanelTitle title="คู่มือทริป" sub="ที่พัก การเดินทาง และทริคก่อนไป" />
                <GuidePanel trip={data.trip} places={data.places} token={session.token} onPlan={() => go({ kind: "plan" })} onOpen={openPlace}
                  onAddStay={() => go({ kind: "add" })} onChanged={refresh} /></>
              )}
              {view.kind === "budget" && (
                <><PanelTitle title="งบทริป" sub="ตั้งงบ ดูว่าแผนนี้ใช้เท่าไหร่ จดค่าใช้จ่าย แล้วหารกันอัตโนมัติ" />
                <BudgetPanel trip={data.trip} members={data.members} expenses={data.expenses ?? []} me={data.me} token={session.token} days={days.length || 1}
                  onChanged={refresh} onPlan={() => go({ kind: "plan" })} toast={toastMsg} /></>
              )}
              {view.kind === "chat" && (
                <><PanelTitle title="แชททริป" sub="คุยกับทุกคนในทริป ส่งตำแหน่ง หรือถามเพื่อนว่าอยู่ไหน" />
                <ChatPanel tripId={tripId} token={session.token} me={data.me} members={data.members} places={data.places} head={chatHead} incoming={chatIn} myPos={myPos}
                  onSent={(m) => { liveCh.current?.chat(m); setChatHead((h) => Math.max(h, m.id)); }} onRead={markRead} onOpenPlace={(pid) => setView({ kind: "place", id: pid })}
                  onShowOnMap={(p) => { setPreview([{ name: p.name, lat: p.lat, lng: p.lng }]); if (!desktop) setSnap("peek"); }} toast={toastMsg} /></>
              )}
              {view.kind === "travel" && (
                <><PanelTitle title="เที่ยวบินและแยกย้าย" sub="เวลาไป–กลับของแต่ละคน ใช้จัดวันแรกและบอกเวลาออกจากที่พักวันสุดท้าย" />
                <TravelPanel tripId={tripId} token={session.token} me={data.me} members={data.members}
                  hotel={days.length ? hotelFor(days.length - 1) ?? null : null}
                  hub={(byDay.get(days.length - 1) ?? []).find((p) => p.category === "transport") ?? (byDay.get(0) ?? []).find((p) => p.category === "transport") ?? null}
                  firstDay={days[0]?.full ?? null} lastDay={days[days.length - 1]?.full ?? null}
                  onSaved={() => { refresh(); toastMsg(data.places.some((p) => p.day_index != null) ? "บันทึกแล้ว กด “จัดทริปใหม่” เพื่อปรับวันแรกและวันสุดท้ายตามเวลานี้" : "บันทึกแล้ว ระบบจะใช้เวลานี้ตอนจัดทริป"); }} /></>
              )}
              {view.kind === "squad" && (
                <><PanelTitle title="แก๊งอยู่ไหน" sub="ดูตำแหน่งและสถานะของทุกคน ส่งอีโมจิทักกัน และปักธงจุดนัดเจอ" />
                <SquadPanel members={data.members} locations={data.locations} me={data.me} rally={rally} stays={stays} sharing={sharing} armed={rallyArm}
                  onToggleShare={toggleShare} onMode={setMode} onPing={ping} onRallyHere={rallyHere} onRallyAt={(p) => setRally(p)}
                  onArm={() => { setRallyArm((a) => !a); if (!desktop) setSnap("peek"); }} onClearRally={() => setRally(null)}
                  onFocus={(id) => { setFocusFriend(id); if (!desktop) setSnap("peek"); }} onAsk={askWhere} /></>
              )}
              {view.kind === "people" && (
                <PeoplePanel trip={data.trip} members={data.members} locations={data.locations} activity={data.activity} me={data.me} token={session.token}
                  sharing={sharing} onToggleShare={toggleShare} onChanged={refresh} toast={toastMsg} />
              )}
            </div>
          ) : (<>
            {planning && (
              <button onClick={() => go({ kind: "plan" })} className="mb-3 flex w-full items-center gap-3 rounded-[16px] bg-ink px-4 py-3 text-left text-white" role="status">
                <span className="size-5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-lime" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold">{planJob?.only_day != null ? `กำลังจัดวันที่ ${planJob.only_day + 1} ใหม่…` : planJob?.chunked && planJob.message ? `กำลังจัดทริป… ${planJob.message}` : "กำลังจัดทริปให้อยู่…"}</span>
                  <span className="block truncate text-[12px] text-white/70">{planJob?.by ? `${planJob.by} กดจัดไว้ · ` : ""}เสร็จแล้วแผนจะขึ้นเองทุกเครื่อง</span>
                </span>
              </button>
            )}
            {tab === "all" ? (
            <AllView days={days.map((d) => ({ index: d.index, label: d.full, color: d.color, theme: data.trip.guide?.themes?.[String(d.index)], places: byDay.get(d.index) ?? [] }))}
              hotels={stays} summary={data.trip.guide?.summary} onDay={(d) => setTab(d)} onOpen={openPlace} onGuide={() => go({ kind: "guide" })}
              prep={data.trip.guide?.prep} tripId={tripId} startDate={data.trip.start_date} members={data.members} onTravel={() => go({ kind: "travel" })} />
          ) : tab === "wish" ? (
            <WishView places={wish} me={data.me} days={days.length} planned={!!data.trip.guide?.generated_at} onOpen={openPlace} onImport={(url) => go({ kind: "import", url })} onAdd={() => go({ kind: "add" })}
              onRecommend={() => go({ kind: "recommend", rec: "attraction" })} onAutoplan={autoplan} onPlan={() => go({ kind: "plan" })} />
          ) : (
            editing === tab ? (
              <DayEditor key={`ed${tab}`} day={tab} rows={dayRows(tab)} color={dayColor(tab)} ctx={dayCtx(tab)}
                onCancel={() => setEditing(null)}
                today={isToday(days[tab]?.date)} onOrder={setEditOrder}
                onSave={(order, edits, base, extra) => saveDay(tab as number, order, extra.drop.length ? `บันทึกแล้ว · ${extra.drop.length} ที่ไปอยู่รอจัด` : "บันทึกแผนวันนี้แล้ว", edits, true, base, extra)} />
            ) :
            <DayView index={tab} label={days[tab]?.full ?? ""} theme={data.trip.guide?.themes?.[String(tab)]} color={dayColor(tab)} places={activeList} me={data.me} dirUrl={dirUrl}
              route={dayRoute} hotel={hotelFor(tab)} onOpen={openPlace} onAdd={() => go({ kind: "add" })} onFood={() => go({ kind: "recommend", rec: "food" })}
              onImport={() => go({ kind: "import" })} onPlan={() => go({ kind: "plan" })} onGuide={() => go({ kind: "guide" })}
              today={isToday(days[tab]?.date)} sharing={sharing} onSquad={() => go({ kind: "squad" })} onSortTime={() => sortByTime(activeList)}
              tripId={tripId} token={session.token} meals={data.trip.prefs?.meals} lastDay={tab === days.length - 1} onPick={pickSuggestion} planning={planning}
              canReplanDay={!!data.trip.start_date && !!data.trip.destination && data.places.some((p) => p.day_index != null && p.day_index !== tab && p.category !== "stay")}
              onReplanDay={() => replanDay(tab as number)} members={data.members} onTravel={() => go({ kind: "travel" })}
              onEdit={activeList.length > 0 && !planning ? () => { setEditing(tab as number); if (!desktop) setSnap("full"); } : undefined} />
          )}</>)}
          {loadErr && <p className="mt-3 text-[12px] text-danger" role="status">{loadErr}</p>}
        </div>
      </aside>
      <Toast text={toast} action={toastAct} />
    </div>
  );
}



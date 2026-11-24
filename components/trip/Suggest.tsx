"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { fmtDur, fmtKm } from "@/lib/client/util";
import { IconHeart, IconPlus, IconWalk, IconCar, IconChevronDown, IconCheck } from "@/components/icons";
import { CatIcon } from "./shared";
import type { Place } from "@/lib/types";

export type SuggestKind = "food" | "cafe" | "attraction";
export type SuggestOpt = {
  wish_id?: string; name: string; category: string; why: string | null; lat: number; lng: number; address: string | null;
  photo: { url: string; page: string; title: string } | null; km: number; min: number; walk: boolean; votes?: number; by?: string | null;
};
export type SuggestReq = { lat: number; lng: number; label?: string; kind: SuggestKind; meal?: string; at?: string };
/** where a picked option goes: day + the stop it follows (null = top of the day) + the time window it must fit */
export type SlotCtx = { day: number | null; after: Place | null; first?: Place | null; from: number | null; until: number | null; minAt?: number | null };
export type PickFn = (o: SuggestOpt, ctx: SlotCtx) => Promise<void>;

const KIND_LABEL: Record<SuggestKind, string> = { attraction: "ที่เที่ยว", cafe: "คาเฟ่", food: "ร้านกิน" };
// one fetch per anchor+kind per session; cleared after every add so the list never offers what's already in
const memo = new Map<string, { t: number; v: Promise<{ options: SuggestOpt[]; error?: string }> }>();
export function clearSuggestMemo() { memo.clear(); }

export const toMin = (t: string | null | undefined) => (t && /^\d{2}:\d{2}/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
export const toHHMM = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const defaultDur = (cat: string) => (cat === "food" ? 60 : cat === "cafe" ? 45 : 75);

export function SuggestList({ tripId, token, req, ctx, onPick }: { tripId: string; token: string; req: SuggestReq; ctx: SlotCtx; onPick: PickFn }) {
  const key = JSON.stringify(req);
  const [state, setState] = useState<{ key: string; options: SuggestOpt[] | null; error: string | null }>({ key, options: null, error: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    const hit = memo.get(key);
    const p = hit && Date.now() - hit.t < 5 * 60_000 ? hit.v : api<{ options: SuggestOpt[]; error?: string }>(`/api/trips/${tripId}/suggest`, { token, body: req });
    if (!hit || hit.v !== p) memo.set(key, { t: Date.now(), v: p });
    p.then((r) => alive && setState({ key, options: r.options, error: r.error ?? null }))
      .catch((e) => { memo.delete(key); if (alive) setState({ key, options: [], error: (e as Error).message }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);

  const loading = state.key !== key || state.options == null;
  if (loading) return (
    <ul className="mt-2 space-y-2" aria-label="กำลังหาที่ใกล้ๆ">
      {[0, 1, 2].map((i) => <li key={i} className="flex items-center gap-3"><span className="skeleton size-12 shrink-0 rounded-[12px]" /><span className="flex-1 space-y-1.5"><span className="skeleton block h-3.5 w-2/3" /><span className="skeleton block h-3 w-1/2" /></span></li>)}
    </ul>
  );
  if (!state.options!.length) return (
    <div className="mt-2 flex items-center gap-2 text-[13px] text-muted">
      <span className="min-w-0 flex-1">{state.error ?? "แถวนี้ยังหาที่เหมาะๆ ไม่เจอ"}</span>
      <button onClick={() => { memo.delete(key); setRetry((n) => n + 1); }} className="h-9 shrink-0 rounded-full border border-line px-3 font-medium text-ink">ลองอีกครั้ง</button>
    </div>
  );
  return (
    <ul className="mt-2 divide-y divide-line">
      {state.options!.map((o) => {
        const id = o.wish_id ?? o.name;
        const added = done.has(id);
        return (
          <li key={id} className="flex items-center gap-3 py-2">
            {o.photo?.url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={o.photo.url} alt="" loading="lazy" className="size-12 shrink-0 rounded-[12px] object-cover" />
              : <span className="grid size-12 shrink-0 place-items-center rounded-[12px] bg-sunken text-ink/70"><CatIcon category={o.category} size={20} /></span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold leading-5">{o.name}</span>
              {o.wish_id
                ? <span className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-medium text-accent"><IconHeart size={12} filled />{o.votes ? `${o.votes} คนอยากไป` : `${o.by ?? "เพื่อน"} เก็บไว้`}</span>
                : o.why ? <span className="block truncate text-[12px] text-muted">{o.why}</span> : null}
              <span className="mt-0.5 flex items-center gap-1 text-[12px] text-muted tnum">
                {o.walk ? <IconWalk size={13} /> : <IconCar size={13} />}{o.walk ? "เดิน" : "นั่งรถ"} {fmtDur(o.min)} · {fmtKm(o.km)}
              </span>
            </span>
            <button disabled={!!busy || added} aria-label={added ? `เพิ่ม ${o.name} แล้ว` : `เพิ่ม ${o.name}`}
              onClick={async () => { setBusy(id); try { await onPick(o, ctx); setDone((s) => new Set(s).add(id)); } finally { setBusy(null); } }}
              className={`grid size-11 shrink-0 place-items-center rounded-full ${added ? "bg-lime text-ink" : "bg-ink text-white"} disabled:opacity-60`}>
              {busy === id ? <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : added ? <IconCheck size={18} /> : <IconPlus size={18} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A dashed slot in the day list: "free 2h — find a stop" or "no lunch yet". Expands in place, one tap to add. */
export function SuggestSlot({ tripId, token, title, sub, kinds, anchor, meal, at, ctx, onPick, tone = "gap" }: {
  tripId: string; token: string; title: string; sub?: string; kinds: SuggestKind[]; anchor: { lat: number; lng: number; label?: string };
  meal?: string; at?: string; ctx: SlotCtx; onPick: PickFn; tone?: "gap" | "meal";
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<SuggestKind>(kinds[0]);
  return (
    <div className={`my-2 rounded-[16px] border border-dashed px-3 py-2 ${tone === "meal" ? "border-[#E8B04A] bg-[#FFF8E8]" : "border-line bg-surface"}`}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-10 w-full items-center gap-2 text-left">
        <span className="text-[18px]" aria-hidden>{tone === "meal" ? "🍜" : "✨"}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold leading-5">{title}</span>
          {sub && <span className="block truncate text-[12px] text-muted">{sub}</span>}
        </span>
        <span className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-semibold ${open ? "bg-sunken" : "bg-ink text-white"}`}>
          {open ? "ปิด" : "ดูไอเดีย"}<IconChevronDown size={14} className={open ? "rotate-180" : ""} />
        </span>
      </button>
      {open && (
        <div className="pb-1">
          {kinds.length > 1 && (
            <div className="mt-1 flex gap-1.5" role="tablist">
              {kinds.map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                  className={`h-8 rounded-full px-3 text-[13px] font-medium ${kind === k ? "bg-ink text-white" : "border border-line"}`}>{KIND_LABEL[k]}</button>
              ))}
            </div>
          )}
          <SuggestList tripId={tripId} token={token} ctx={ctx} onPick={onPick}
            req={{ lat: +anchor.lat.toFixed(4), lng: +anchor.lng.toFixed(4), label: anchor.label, kind, ...(meal ? { meal } : {}), ...(at ? { at } : {}) }} />
        </div>
      )}
    </div>
  );
}

/** "ใกล้ๆ ที่นี่" inside a place's detail page. */
export function NearHere({ tripId, token, place, onPick }: { tripId: string; token: string; place: Place; onPick: PickFn }) {
  const [kind, setKind] = useState<SuggestKind | null>(null);
  if (place.lat == null || place.lng == null) return null;
  const end = toMin(place.start_time) != null ? toMin(place.start_time)! + (place.duration_min ?? 60) : null;
  return (
    <section>
      <h3 className="text-[15px] font-semibold">ใกล้ๆ ที่นี่</h3>
      <p className="text-[12px] text-muted">{place.day_index != null ? "แตะ + เพื่อแวะต่อจากที่นี่ในวันเดียวกัน" : "แตะ + เพื่อเก็บไว้ในรายการรอจัด"}</p>
      <div className="mt-2 flex gap-1.5" role="tablist">
        {(["food", "cafe", "attraction"] as SuggestKind[]).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={`h-9 rounded-full px-3.5 text-[14px] font-medium ${kind === k ? "bg-ink text-white" : "border border-line"}`}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      {kind && (
        <SuggestList tripId={tripId} token={token} onPick={onPick}
          ctx={{ day: place.day_index, after: place.day_index != null ? place : null, from: end, until: null }}
          req={{ lat: +place.lat.toFixed(4), lng: +place.lng.toFixed(4), label: place.name, kind, ...(end != null ? { at: toHHMM(end) } : {}) }} />
      )}
    </section>
  );
}

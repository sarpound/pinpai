"use client";
import { api } from "./api";

export type PushState = "on" | "off" | "denied" | "unsupported" | "needs-install";

const b64 = (s: string) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** What this device can do right now. iPhone/iPad only allow web push from an app added to the Home Screen. */
export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return isIOS() && !standalone() ? "needs-install" : "unsupported";
  if (isIOS() && !standalone()) return "needs-install";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** Ask permission (must be called from a tap), subscribe and register this device for the trip. */
export async function enablePush(tripId: string, token: string): Promise<PushState> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { key } = await api<{ key: string }>(`/api/trips/${tripId}/push`, { token });
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with another key can't be reused
  if (sub && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== key) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  await api(`/api/trips/${tripId}/push`, { token, body: { subscription: sub.toJSON() } });
  return "on";
}

export async function disablePush(tripId: string, token: string): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  await api(`/api/trips/${tripId}/push`, { token, method: "DELETE", body: sub ? { endpoint: sub.endpoint } : {} }).catch(() => {});
  await sub?.unsubscribe().catch(() => {});
  return "off";
}

/** A subscription belongs to the browser, not to a trip: when this device already has one, quietly register it for this trip too. */
export async function syncPush(tripId: string, token: string) {
  try {
    if ((await pushState()) !== "on") return;
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    const sub = await reg?.pushManager.getSubscription();
    const key = `pinpai.push.${tripId}`;
    if (!sub || localStorage.getItem(key) === sub.endpoint) return;
    await api(`/api/trips/${tripId}/push`, { token, body: { subscription: sub.toJSON(), quiet: true } });
    localStorage.setItem(key, sub.endpoint);
  } catch { /* optional */ }
}

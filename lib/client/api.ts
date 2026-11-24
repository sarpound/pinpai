"use client";
export type Session = { token: string; memberId: string; title?: string; emoji?: string; role?: "owner" | "editor"; savedAt: number };
const KEY = "pinpai.sessions.v1";

export function getSessions(): Record<string, Session> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}
export function saveSession(tripId: string, s: Omit<Session, "savedAt">) {
  const all = getSessions();
  all[tripId] = { ...all[tripId], ...s, savedAt: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}
export function forgetSession(tripId: string) {
  const all = getSessions();
  delete all[tripId];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
}
export function getName(): string {
  try { return localStorage.getItem("pinpai.name") ?? ""; } catch { return ""; }
}
export function setName(n: string) {
  try { localStorage.setItem("pinpai.name", n); } catch {}
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { "x-pp-token": opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? "เกิดข้อผิดพลาด"), { status: r.status });
  return j as T;
}

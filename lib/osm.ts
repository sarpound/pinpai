// Shared politeness for the public OpenStreetMap services, per server instance.
// Nominatim's policy is ≤ 1 request/second per application: every caller (geocoding, meals, hotels, wants) waits its
// turn in ONE queue here instead of each module keeping its own clock (which let 6 parallel lookups through at once,
// got us 429s and left whole trips on approximate pins). Photon gets a small concurrency cap and back-off.

let chain: Promise<void> = Promise.resolve();
let last = 0;
/** resolves when it's this caller's turn to hit Nominatim (≥ 1.1 s after the previous call) */
export function nominatimSlot(): Promise<void> {
  const turn = chain.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  });
  chain = turn.catch(() => {});
  return turn;
}

let active = 0;
const waiters: (() => void)[] = [];
/** at most 3 Photon requests in flight per instance */
export async function photonSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}

/** fetch with one polite retry on 429 / 5xx (honours Retry-After up to 4 s) */
export async function osmFetch(url: string | URL, init: RequestInit, nominatim: boolean): Promise<Response | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (nominatim) await nominatimSlot();
    try {
      const r = await fetch(url, init);
      if (r.ok) return r;
      if (r.status !== 429 && r.status < 500) return r;
      const ra = Number(r.headers.get("retry-after"));
      await new Promise((res) => setTimeout(res, Math.min(4000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600 * 2 ** attempt)));
    } catch {
      await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
    }
  }
  return null;
}

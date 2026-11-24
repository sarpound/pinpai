// Travel status ("mode") shared by server (auto-detect) and client (labels/badges).
export const MODES = {
  plane: { emoji: "✈️", label: "กำลังบิน", short: "บิน" },
  train: { emoji: "🚆", label: "นั่งรถไฟ", short: "รถไฟ" },
  boat: { emoji: "⛴️", label: "นั่งเรือ", short: "เรือ" },
  bus: { emoji: "🚌", label: "นั่งรถบัส/รถเมล์", short: "รถเมล์" },
  taxi: { emoji: "🚕", label: "นั่งแท็กซี่/Grab", short: "แท็กซี่" },
  car: { emoji: "🚗", label: "อยู่บนรถ", short: "รถ" },
  walk: { emoji: "🚶", label: "เดินอยู่", short: "เดิน" },
  eat: { emoji: "🍜", label: "กินอยู่", short: "กิน" },
  place: { emoji: "📍", label: "เที่ยวอยู่", short: "เที่ยว" },
  hotel: { emoji: "🏨", label: "ถึงที่พักแล้ว", short: "ที่พัก" },
  rally: { emoji: "🚩", label: "ถึงจุดนัดแล้ว", short: "ถึงจุดนัด" },
  still: { emoji: "😌", label: "พักอยู่", short: "พัก" },
} as const;
export type Mode = keyof typeof MODES;
export const MANUAL_MODES: Mode[] = ["plane", "train", "boat", "bus", "taxi", "car", "walk", "eat", "hotel"];
export const isMode = (m: unknown): m is Mode => typeof m === "string" && m in MODES;
export const MOVING: Mode[] = ["plane", "train", "boat", "bus", "taxi", "car", "walk"];

type P = { lat: number; lng: number };
export function km(a: P, b: P) {
  const R = 6371, r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearing(a: P, b: P) {
  const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/**
 * Guess how someone is travelling from speed + where they are.
 * Speed bands are deliberately wide; anything the guess gets wrong is one tap to correct.
 */
export function detectMode(o: {
  kmh: number | null; jumpKm: number; gapMin: number; here: P;
  stays: P[]; rally: P | null; stops: (P & { category: string })[]; travelPref?: string | null;
}): Mode {
  const { kmh, jumpKm, gapMin, here } = o;
  // big jump since the last fix (phone was off in the air) → just flew in
  if (jumpKm > 250 && gapMin < 24 * 60) return "plane";
  if (kmh != null && kmh > 230) return "plane";
  if (o.rally && km(here, o.rally) < 0.12) return "rally";
  if (o.stays.some((s) => km(here, s) < 0.15) && (kmh ?? 0) < 6) return "hotel";
  if (kmh != null && kmh > 140) return "train"; // high-speed rail
  if (kmh != null && kmh > 9) {
    if (o.travelPref === "transit") return kmh > 70 ? "train" : "bus";
    if (o.travelPref === "drive") return "car";
    return "taxi";
  }
  if (kmh != null && kmh > 2) return "walk";
  const at = o.stops.find((s) => km(here, s) < 0.12);
  if (at) return at.category === "food" || at.category === "cafe" ? "eat" : "place";
  return "still";
}

import { IconBag, IconBed, IconBus, IconCoffee, IconDot, IconLandmark, IconMoon, IconTree, IconUtensils } from "@/components/icons";

// สีประจำวัน — index = JS getDay() (0 = Sunday)
export const DAY_COLORS = ["#D92D3A", "#F2B705", "#D6337F", "#1B7A43", "#C2540A", "#2563C9", "#7A3FC2"];
export const NEUTRAL = "#5D6570";
const TH_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const TH_DAYS_FULL = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export function parseDate(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function dayList(start: string | null, end: string | null) {
  if (!start) return [];
  const s = parseDate(start), e = parseDate(end ?? start);
  const out: { index: number; date: Date; color: string; wd: number; short: string; num: number; month: string; full: string }[] = [];
  for (let i = 0, t = s.getTime(); t <= e.getTime() && i < 31; i++, t += 864e5) {
    const d = new Date(t), wd = d.getUTCDay();
    out.push({ index: i, date: d, wd, color: DAY_COLORS[wd], short: TH_DAYS[wd], num: d.getUTCDate(), month: TH_MONTHS[d.getUTCMonth()],
      full: `วัน${TH_DAYS_FULL[wd]}ที่ ${d.getUTCDate()} ${TH_MONTHS[d.getUTCMonth()]}` });
  }
  return out;
}
export function fmtRange(start: string | null, end: string | null) {
  if (!start) return "ยังไม่ระบุวัน";
  const s = parseDate(start), e = parseDate(end ?? start);
  const n = Math.round((e.getTime() - s.getTime()) / 864e5) + 1;
  const a = `${s.getUTCDate()} ${TH_MONTHS[s.getUTCMonth()]}`;
  const b = `${e.getUTCDate()} ${TH_MONTHS[e.getUTCMonth()]}`;
  return n === 1 ? `${a} · 1 วัน` : `${a} – ${b} · ${n} วัน ${n - 1} คืน`;
}
export function inkOn(color: string) {
  return color.toUpperCase() === "#F2B705";
}
export function distKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Rough travel estimate from straight-line distance (road factor 1.3). */
export function travel(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const km = distKm(a, b) * 1.3;
  if (km < 1.2) return { mode: "walk" as const, min: Math.max(1, Math.round((km / 4.8) * 60)), km };
  return { mode: "car" as const, min: Math.max(3, Math.round((km / 28) * 60 + 4)), km };
}
export function fmtKm(km: number) {
  return km < 1 ? `${Math.round(km * 1000 / 10) * 10} ม.` : `${km.toFixed(km < 10 ? 1 : 0)} กม.`;
}
export function fmtDur(min: number) {
  if (min < 60) return `${min} นาที`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}
export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "เมื่อกี้";
  if (s < 3600) return `${Math.round(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.round(s / 3600)} ชม.ที่แล้ว`;
  return `${Math.round(s / 86400)} วันที่แล้ว`;
}
export const CATEGORY: Record<string, { label: string; Icon: (p: { size?: number }) => React.ReactNode }> = {
  attraction: { label: "ที่เที่ยว", Icon: IconLandmark },
  food: { label: "ร้านอาหาร", Icon: IconUtensils },
  cafe: { label: "คาเฟ่", Icon: IconCoffee },
  stay: { label: "ที่พัก", Icon: IconBed },
  shopping: { label: "ช้อปปิ้ง", Icon: IconBag },
  nightlife: { label: "กลางคืน", Icon: IconMoon },
  nature: { label: "ธรรมชาติ", Icon: IconTree },
  transport: { label: "การเดินทาง", Icon: IconBus },
  other: { label: "อื่นๆ", Icon: IconDot },
};
export function gmapsPlace(p: { name: string; lat: number | null; lng: number | null }, hint?: string | null) {
  // in mainland China the place page opens in Amap (Google Maps does not work there)
  if (p.lat != null && p.lng != null && inMainlandChina(p.lat, p.lng)) return amapPlace(p);
  const q = [p.name.replace(/\s*\(.*\)$/, ""), hint].filter(Boolean).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q || `${p.lat},${p.lng}`)}`;
}
export function gmapsDirections(stops: { lat: number | null; lng: number | null }[], mode?: string) {
  const s = stops.filter((p) => p.lat != null).slice(0, 10);
  if (s.length < 2) return null;
  // Google Maps does not work in mainland China and Amap has no multi-stop link: each leg there has its own Amap button
  if (inMainlandChina(s[0].lat!, s[0].lng!)) return null;
  const pt = (p: { lat: number | null; lng: number | null }) => `${p.lat},${p.lng}`;
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("origin", pt(s[0]));
  u.searchParams.set("destination", pt(s[s.length - 1]));
  if (s.length > 2) u.searchParams.set("waypoints", s.slice(1, -1).map(pt).join("|"));
  // Google ignores waypoints for transit, so multi-stop days open as driving/walking routes
  u.searchParams.set("travelmode", mode === "walk" ? "walking" : mode === "transit" && s.length === 2 ? "transit" : "driving");
  return u.toString();
}

export { inMainlandChina, amapPlace, amapRoute } from "@/lib/maplinks";
import { inMainlandChina, amapRoute, amapPlace } from "@/lib/maplinks";

/** Turn-by-turn link to one place from where the phone is: Amap inside mainland China, Google Maps elsewhere. */
export function navUrl(p: { lat: number | null; lng: number | null; name: string }) {
  if (p.lat == null || p.lng == null) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`;
  if (inMainlandChina(p.lat, p.lng)) return amapRoute({ lat: p.lat, lng: p.lng, name: p.name }, "bus");
  return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
}

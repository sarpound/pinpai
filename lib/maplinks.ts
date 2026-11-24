// Map-app links that work where the group actually is: Amap (高德) in mainland China, Google Maps elsewhere.
// Pure functions — used by the server (route legs) and the app.

export type LL = { lat: number; lng: number };

/** Rough test for mainland China (Google Maps is unavailable there). Excludes Taiwan, Hong Kong/Macau, Korea, Japan, SE Asia. */
// Hong Kong ends at the Shenzhen river (~22.51°N); Shekou/Nanshan sit west of 114°E above 22.44°N
export const inHongKong = (lat: number, lng: number) => lng > 113.83 && lng < 114.45 && lat > 22.15 && lat < 22.51 && !(lng < 114 && lat > 22.44);
export const inMacau = (lat: number, lng: number) => lng > 113.52 && lng < 113.6 && lat > 22.1 && lat < 22.22;
export function inMainlandChina(lat: number, lng: number) {
  if (lat < 18 || lat > 53.6 || lng < 73.5 || lng > 135) return false;
  if (lng > 119.3 && lng < 122.2 && lat > 21.7 && lat < 25.4) return false; // Taiwan
  if (inHongKong(lat, lng) || inMacau(lat, lng)) return false;
  if (lng > 124 && lat < 42.5) return false; // Korea / Japan
  if (lat < 21.5 && lng < 108) return false; // Vietnam / Laos / Myanmar / Thailand
  if (lat < 28.3 && lng < 97.5) return false; // India / Bhutan / Myanmar
  if (lng < 89 && lat < 30.5) return false; // India / Nepal (Lhasa 91°E stays in)
  if (lng < 80 && lat < 36) return false; // Pakistan / Kashmir
  if (lng < 80.2 && lat > 40.5) return false; // Kyrgyzstan / Kazakhstan (Kashgar 39.5°N stays in)
  if (lat > 42 && lng > 96 && lng < 119 && lat > 41.6 + (lng - 96) * 0.25) return false; // Mongolia (rough)
  return true;
}

/** "灵隐寺 (Lingyin Temple)" → "灵隐寺": the name a local app / driver understands */
export const localName = (name: string) => name.match(/^(.*?)\s*\((.*)\)\s*$/)?.[1] ?? name;

/** The place page in Amap (search by name around the pin → reviews, photos, hours), or a pin when there is no name. */
export function amapPlace(p: { name: string; lat: number | null; lng: number | null }) {
  const n = encodeURIComponent(localName(p.name));
  if (p.lat == null || p.lng == null) return `https://uri.amap.com/search?keyword=${n}&callnative=1`;
  return `https://uri.amap.com/search?keyword=${n}&center=${p.lng},${p.lat}&view=map&callnative=1`;
}
export const amapPin = (p: { name: string; lat: number; lng: number }) =>
  `https://uri.amap.com/marker?position=${p.lng},${p.lat}&name=${encodeURIComponent(localName(p.name))}&coordinate=wgs84&callnative=1`;

/** A→B in Amap (mode car / bus / walk / ride); without `from` it starts where the phone is. */
export function amapRoute(to: LL & { name?: string }, mode: "car" | "bus" | "walk" | "ride" = "bus", from?: LL & { name?: string }) {
  const pt = (p: LL & { name?: string }) => `${p.lng},${p.lat}${p.name ? `,${encodeURIComponent(localName(p.name))}` : ""}`;
  return `https://uri.amap.com/navigation?${from ? `from=${pt(from)}&` : ""}to=${pt(to)}&mode=${mode}&policy=1&coordinate=wgs84&callnative=1`;
}

export function gmapsRoute(a: LL, b: LL, mode: "walk" | "transit" | "car") {
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("origin", `${a.lat},${a.lng}`);
  u.searchParams.set("destination", `${b.lat},${b.lng}`);
  u.searchParams.set("travelmode", mode === "walk" ? "walking" : mode === "transit" ? "transit" : "driving");
  return u.toString();
}

/** A→B in the right app for the country */
export function routeUrl(a: LL & { name?: string }, b: LL & { name?: string }, mode: "walk" | "transit" | "car") {
  if (inMainlandChina(a.lat, a.lng) || inMainlandChina(b.lat, b.lng)) return amapRoute(b, mode === "walk" ? "walk" : mode === "transit" ? "bus" : "car", a);
  return gmapsRoute(a, b, mode);
}

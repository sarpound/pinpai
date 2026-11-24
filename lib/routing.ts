// Real road routes via OSRM on OpenStreetMap (FOSSGIS public instance, then the OSRM demo).
// One request per day (all waypoints), cached in pinpai.route_cache so repeat views cost nothing.
import { createHash } from "crypto";
import { sql } from "./db";
import { distKm } from "./geo";
import { legMinutes, type Calib } from "./retime";
import { routeUrl } from "./maplinks";
import { carLabel } from "./transport";

export type Mode = "transit" | "taxi" | "drive" | "walk";
export type LL = { lat: number; lng: number };
export type Leg = { km: number; min: number; mode: "walk" | "car" | "transit"; label: string; url: string };
export type DayRoute = { legs: Leg[]; geometry: [number, number][]; exact: boolean; samples?: { straight: number; road: number; carMin: number }[] };

const UA = "PinPai/0.2 (trip planner; https://pinpai-sarpounds-projects.vercel.app)";

// Amap inside mainland China (Google Maps does not work there), Google Maps elsewhere
const gmapsLeg = (a: LL, b: LL, mode: Leg["mode"]) => routeUrl(a, b, mode);

// same model as the timetable (lib/retime legMinutes), so leg times and planned times agree
function legFor(a: LL, b: LL, roadKm: number, carMin: number | null, mode: Mode, calib?: Calib | null): Leg {
  const { min, kind } = legMinutes(roadKm, carMin, mode, calib);
  if (kind === "walk") return { km: roadKm, min, mode: "walk", label: `เดิน ${min} นาที`, url: gmapsLeg(a, b, "walk") };
  if (kind === "transit") return { km: roadKm, min, mode: "transit", label: `รถไฟฟ้า/รถเมล์ ~${min} นาที`, url: gmapsLeg(a, b, "transit") };
  return { km: roadKm, min, mode: "car", label: `${mode === "taxi" ? carLabel(b) : "ขับรถ"} ~${min} นาที`, url: gmapsLeg(a, b, "car") };
}

async function osrm(points: LL[]): Promise<{ legs: { distance: number; duration: number }[]; geometry: [number, number][] } | null> {
  const coords = points.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const hosts = [
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coords}`,
    `https://router.project-osrm.org/route/v1/driving/${coords}`,
  ];
  for (const h of hosts) {
    try {
      const r = await fetch(`${h}?overview=simplified&geometries=geojson&steps=false`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { code: string; routes?: { legs: { distance: number; duration: number }[]; geometry: { coordinates: [number, number][] } }[] };
      if (j.code === "Ok" && j.routes?.[0]) return { legs: j.routes[0].legs, geometry: j.routes[0].geometry.coordinates };
    } catch {}
  }
  return null;
}

export async function routeDay(points: LL[], mode: Mode, calib?: Calib | null): Promise<DayRoute> {
  if (points.length < 2) return { legs: [], geometry: points.map((p) => [p.lng, p.lat]), exact: true };
  const pts = points.slice(0, 25);
  const key = createHash("sha1").update(pts.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|")).digest("hex");
  let raw: { legs: { distance: number; duration: number }[]; geometry: [number, number][] } | null = null;
  const [hit] = await sql`select data from pinpai.route_cache where key = ${key} and created_at > now() - interval '30 days'`;
  if (hit) raw = hit.data as never;
  else {
    raw = await osrm(pts);
    if (raw) await sql`insert into pinpai.route_cache (key, data) values (${key}, ${sql.json(raw as never)}) on conflict (key) do update set data = excluded.data, created_at = now()`;
  }
  if (raw && raw.legs.length === pts.length - 1) {
    return {
      exact: true,
      geometry: raw.geometry,
      legs: raw.legs.map((l, i) => legFor(pts[i], pts[i + 1], l.distance / 1000, l.duration / 60, mode, calib)),
      samples: raw.legs.map((l, i) => ({ straight: distKm(pts[i], pts[i + 1]), road: l.distance / 1000, carMin: l.duration / 60 })),
    };
  }
  // fallback: straight-line estimate
  return {
    exact: false,
    geometry: pts.map((p) => [p.lng, p.lat]),
    legs: pts.slice(1).map((b, i) => {
      const d = calib?.detour ? Math.min(1.6, Math.max(1.15, calib.detour)) : 1.3;
      return legFor(pts[i], b, distKm(pts[i], b) * d, null, mode, calib);
    }),
  };
}

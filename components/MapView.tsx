"use client";
import { useEffect, useRef } from "react";
import maplibregl, { Map as MLMap, Marker, LngLatBounds } from "maplibre-gl";
import { avatarSvg } from "@/lib/client/avatar";

export type MapPin = { id: string; lat: number; lng: number; color: string | null; label: string; ink?: boolean; kind: "stop" | "wish" | "cand" | "stay"; title: string; dim?: boolean; name?: string };
export type MapFriend = { id: string; lat: number; lng: number; color: string; initial: string; name: string; stale: boolean; me?: boolean;
  badge?: string; moving?: boolean; heading?: number | null; plane?: boolean; trail?: [number, number][]; mini?: boolean };
export type MapPop = { key: string; memberId: string; emoji: string; burst?: boolean };
export type MapRally = { lat: number; lng: number; name: string };
export type MapRoute = { id: string; color: string; coords: [number, number][]; dim?: boolean };

type Props = {
  pins: MapPin[];
  friends: MapFriend[];
  routes: MapRoute[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  center: { lat: number; lng: number } | null;
  fitKey: string; // change to re-fit bounds
  focus?: { lat: number; lng: number }[]; // points to fit (defaults to all pins)
  padding?: { top: number; bottom: number; left: number; right: number };
  onMapClick?: (ll: { lat: number; lng: number }) => void;
  onFriend?: (id: string) => void;
  pops?: MapPop[];
  rally?: MapRally | null;
};

function setOwnClasses(el: HTMLElement, cls: string) {
  const keep = [...el.classList].filter((c) => c.startsWith("maplibregl-"));
  el.className = [...keep, ...cls.split(" ").filter(Boolean)].join(" ");
}

const STYLE = "https://tiles.openfreemap.org/styles/positron";

export default function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const friendMarkers = useRef(new Map<string, Marker>());
  const friendPos = useRef(new Map<string, { lat: number; lng: number; raf?: number }>());
  const seenPops = useRef(new Set<string>());
  const rallyMarker = useRef<Marker | null>(null);
  const ready = useRef(false);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current, style: STYLE, attributionControl: { compact: true },
      center: p.center ? [p.center.lng, p.center.lat] : [100.5018, 13.7563], zoom: p.center ? 11 : 5,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: false }), "top-right");
    m.on("load", () => {
      m.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      // breadcrumb trails of friends on the move: dotted, in their colour
      m.addSource("trails", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "trails", type: "line", source: "trails", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.55, "line-dasharray": [0.1, 1.8] } });
      // other days: thin dashed, faded
      m.addLayer({ id: "route-dim", type: "line", source: "routes", filter: ["==", ["get", "dim"], true], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.45, "line-dasharray": [1.5, 2] } });
      // active day: white casing + bold colour + direction arrows
      m.addLayer({ id: "route-casing", type: "line", source: "routes", filter: ["!=", ["get", "dim"], true], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["case", ["get", "yellow"], "#8A6A00", "#ffffff"], "line-width": 9 } });
      m.addLayer({ id: "route", type: "line", source: "routes", filter: ["!=", ["get", "dim"], true], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 5.5 } });
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      const g = c.getContext("2d")!;
      g.strokeStyle = "#ffffff"; g.lineWidth = 4.5; g.lineCap = "round"; g.lineJoin = "round";
      g.beginPath(); g.moveTo(11, 8); g.lineTo(21, 16); g.lineTo(11, 24); g.stroke();
      if (!m.hasImage("pp-arrow")) m.addImage("pp-arrow", g.getImageData(0, 0, 32, 32), { pixelRatio: 2 });
      m.addLayer({ id: "route-arrows", type: "symbol", source: "routes", filter: ["!=", ["get", "dim"], true],
        layout: { "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "pp-arrow", "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-rotation-alignment": "map" } });
      ready.current = true;
      drawRoutes();
      drawTrails();
      fit();
    });
    m.on("click", (e) => {
      const t = e.originalEvent.target as HTMLElement;
      if (t.closest(".pp-pin,.pp-dot,.pp-friend,.pp-person,.pp-rally")) return;
      latest.current.onSelect(null);
      latest.current.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    map.current = m;
    return () => { m.remove(); map.current = null; ready.current = false; markers.current.clear(); friendMarkers.current.clear(); rallyMarker.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function drawRoutes() {
    const m = map.current;
    if (!m || !ready.current) return;
    const src = m.getSource("routes") as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: latest.current.routes.filter((r) => r.coords.length > 1).map((r) => ({
        type: "Feature", properties: { color: r.color, dim: !!r.dim, yellow: r.color.toUpperCase() === "#F2B705" },
        geometry: { type: "LineString", coordinates: r.coords },
      })),
    });
  }

  function drawTrails() {
    const m = map.current;
    if (!m || !ready.current) return;
    (m.getSource("trails") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: latest.current.friends.filter((f) => (f.trail?.length ?? 0) > 1).map((f) => ({
        type: "Feature", properties: { color: f.color },
        geometry: { type: "LineString", coordinates: [...f.trail!, [f.lng, f.lat]] },
      })),
    });
  }

  function fit() {
    const m = map.current;
    if (!m) return;
    const { pins, friends, center, padding, focus } = latest.current;
    const pts = focus && focus.length ? focus : [...pins, ...friends];
    const pad = padding ?? { top: 60, bottom: 60, left: 40, right: 40 };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (pts.length >= 2) {
      const b = new LngLatBounds();
      pts.forEach((x) => b.extend([x.lng, x.lat]));
      m.fitBounds(b, { padding: pad, maxZoom: 15, duration: reduce ? 0 : 600 });
    } else if (pts.length === 1) {
      m.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: 14, padding: pad, duration: reduce ? 0 : 600 });
    } else if (center) {
      m.easeTo({ center: [center.lng, center.lat], zoom: 11, padding: pad, duration: reduce ? 0 : 600 });
    }
  }

  // markers
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const pin of p.pins) {
      seen.add(pin.id);
      let mk = markers.current.get(pin.id);
      const cls = pin.kind === "stop" ? `pp-pin${pin.ink ? " ink" : ""}` : pin.kind === "stay" ? "pp-stay" : `pp-dot${pin.kind === "cand" ? " cand" : ""}`;
      if (!mk) {
        const node = document.createElement("button");
        node.type = "button";
        node.addEventListener("click", (e) => { e.stopPropagation(); latest.current.onSelect(node.dataset.id ?? null); });
        mk = new maplibregl.Marker({ element: node }).setLngLat([pin.lng, pin.lat]).addTo(m);
        markers.current.set(pin.id, mk);
      }
      const node = mk.getElement() as HTMLButtonElement;
      node.dataset.id = pin.id;
      // keep MapLibre's own classes (maplibregl-marker…) — they position the marker absolutely
      setOwnClasses(node, `${cls}${p.selectedId === pin.id ? " sel" : ""}${pin.dim ? " dim" : ""}`);
      node.style.background = pin.kind === "stop" ? pin.color ?? "#5D6570" : "";
      node.classList.toggle("dim", !!pin.dim);
      if (pin.kind === "stay") node.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9"/></svg>';
      else {
        node.textContent = pin.kind === "stop" ? pin.label : "";
        if (pin.name && !pin.dim) {
          const lab = document.createElement("span");
          lab.className = "pp-label";
          lab.textContent = pin.name.replace(/\s*\(.*\)$/, "");
          node.appendChild(lab);
        }
      }
      node.setAttribute("aria-label", pin.title);
      node.title = pin.title;
      mk.setLngLat([pin.lng, pin.lat]);
      // z-order: selected on top
      (mk.getElement().style as CSSStyleDeclaration).zIndex = p.selectedId === pin.id ? "10" : pin.kind === "stop" || pin.kind === "stay" ? "3" : "1";
    }
    for (const [id, mk] of markers.current) if (!seen.has(id)) { mk.remove(); markers.current.delete(id); }
  }, [p.pins, p.selectedId]);

  // friends: cartoon face + vehicle badge; glide to new positions like a game piece
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const f of p.friends) {
      seen.add(f.id);
      let mk = friendMarkers.current.get(f.id);
      if (!mk) {
        const node = document.createElement("button");
        node.type = "button";
        const face = document.createElement("span"); face.className = "pp-face";
        const badge = document.createElement("span"); badge.className = "pp-badge";
        const tail = document.createElement("span"); tail.className = "pp-tail";
        const name = document.createElement("span"); name.className = "pp-name";
        const pops = document.createElement("span"); pops.className = "pp-pops";
        node.append(pops, face, badge, tail, name);
        node.addEventListener("click", (e) => { e.stopPropagation(); latest.current.onFriend?.(node.dataset.id ?? ""); });
        mk = new maplibregl.Marker({ element: node, anchor: "bottom" }).setLngLat([f.lng, f.lat]).addTo(m);
        friendMarkers.current.set(f.id, mk);
        friendPos.current.set(f.id, { lat: f.lat, lng: f.lng });
      }
      const node = mk.getElement() as HTMLButtonElement;
      node.dataset.id = f.id;
      node.dataset.ll = `${f.lat.toFixed(5)},${f.lng.toFixed(5)}`; // latest target (handy for tests)
      setOwnClasses(node, `pp-person${f.stale ? " stale" : ""}${f.me ? " me" : ""}${f.moving ? " moving" : ""}${f.mini ? " mini" : ""}`);
      node.style.zIndex = f.me ? "31" : "30";
      node.style.setProperty("--pp-color", f.color);
      const [, face, badge, , name] = node.children as unknown as HTMLElement[];
      if (face.dataset.seed !== f.id + f.color) { face.innerHTML = avatarSvg(f.id, f.color, 40); face.dataset.seed = f.id + f.color; } // our own SVG — no user text
      badge.textContent = f.badge ?? "";
      badge.hidden = !f.badge;
      badge.style.setProperty("--pp-rot", f.plane && f.heading != null ? `${Math.round(f.heading - 45)}deg` : "0deg");
      name.textContent = f.me ? "คุณ" : f.name;
      node.setAttribute("aria-label", f.me ? "ตำแหน่งของคุณ" : `${f.name}${f.stale ? " (อัปเดตนานแล้ว)" : ""}`);
      glide(f.id, mk, f.lat, f.lng);
    }
    for (const [id, mk] of friendMarkers.current) if (!seen.has(id)) { mk.remove(); friendMarkers.current.delete(id); friendPos.current.delete(id); }
    drawTrails();
  }, [p.friends]); // eslint-disable-line react-hooks/exhaustive-deps

  function glide(id: string, mk: Marker, lat: number, lng: number) {
    const cur = friendPos.current.get(id) ?? { lat, lng };
    if (cur.raf) cancelAnimationFrame(cur.raf);
    const far = Math.abs(cur.lat - lat) + Math.abs(cur.lng - lng) > 0.5; // teleports (flights) just jump
    if (far || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      mk.setLngLat([lng, lat]); friendPos.current.set(id, { lat, lng }); return;
    }
    const from = { ...cur }, t0 = performance.now(), dur = 1400;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      const pos = { lat: from.lat + (lat - from.lat) * e, lng: from.lng + (lng - from.lng) * e };
      mk.setLngLat([pos.lng, pos.lat]);
      friendPos.current.set(id, { ...pos, raf: k < 1 ? requestAnimationFrame(step) : undefined });
    };
    friendPos.current.set(id, { ...from, raf: requestAnimationFrame(step) });
  }

  // emoji reactions + arrival confetti float up from the sender's avatar
  useEffect(() => {
    for (const pop of p.pops ?? []) {
      if (seenPops.current.has(pop.key)) continue;
      seenPops.current.add(pop.key);
      const holder = friendMarkers.current.get(pop.memberId)?.getElement().querySelector(".pp-pops");
      if (!holder) continue;
      const n = pop.burst ? 7 : 1;
      for (let i = 0; i < n; i++) {
        const b = document.createElement("span");
        b.className = pop.burst ? "pp-pop burst" : "pp-pop";
        b.textContent = pop.burst ? ["🎉", "✨", "🎊", "⭐", "💛", "🎉", "✨"][i] : pop.emoji;
        b.style.setProperty("--dx", `${pop.burst ? (i - 3) * 16 : 0}px`);
        b.style.animationDelay = `${i * 60}ms`;
        holder.appendChild(b);
        window.setTimeout(() => b.remove(), 2600 + i * 60);
      }
    }
  }, [p.pops]);

  // meeting-point flag
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const r = p.rally;
    if (!r) { rallyMarker.current?.remove(); rallyMarker.current = null; return; }
    if (!rallyMarker.current) {
      const node = document.createElement("div");
      node.innerHTML = '<span class="pp-flag" aria-hidden="true">🚩</span><span class="pp-rally-name"></span>';
      rallyMarker.current = new maplibregl.Marker({ element: node, anchor: "bottom" }).setLngLat([r.lng, r.lat]).addTo(m);
    }
    const node = rallyMarker.current.getElement();
    setOwnClasses(node, "pp-rally");
    (node.querySelector(".pp-rally-name") as HTMLElement).textContent = r.name;
    node.setAttribute("aria-label", `จุดนัดเจอ: ${r.name}`);
    node.style.zIndex = "25";
    rallyMarker.current.setLngLat([r.lng, r.lat]);
  }, [p.rally?.lat, p.rally?.lng, p.rally?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(drawRoutes, [p.routes]);
  // sheet moved / window resized → keep the plan in view
  const padKey = JSON.stringify(p.padding ?? {});
  useEffect(() => { if (ready.current) { map.current?.resize(); fit(); } }, [padKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current) fit(); }, [p.fitKey]);

  // fly to selection
  useEffect(() => {
    const m = map.current;
    if (!m || !p.selectedId) return;
    const pin = p.pins.find((x) => x.id === p.selectedId);
    if (!pin) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    m.easeTo({ center: [pin.lng, pin.lat], zoom: Math.max(m.getZoom(), 14), padding: p.padding, duration: reduce ? 0 : 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selectedId]);

  // maplibre sets .maplibregl-map { position: relative } on the container, so size it with h/w-full inside a positioned wrapper
  return <div className="absolute inset-0"><div ref={el} className="h-full w-full" role="region" aria-label="แผนที่ทริป" /></div>;
}

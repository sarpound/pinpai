import { requireHuman } from "@/lib/ratelimit";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { handle, requireMember, readJson, str, HttpError } from "@/lib/auth";
import { fetchSocialPost, firstUrl, detectPlatform, normalizeUrl, googleMapsPlace } from "@/lib/social";
import { extractPlacesFromPost } from "@/lib/ai";
import { resolvePlace, searchPlaces, distKm } from "@/lib/geo";
import { aiBudget } from "@/lib/limits";

export const maxDuration = 60;

/**
 * Video/post → candidate places. Does NOT save places; the client shows a review list
 * and posts the chosen ones to /places/bulk. Input: { url?, caption?, image? (data URL screenshot) }
 */
export async function POST(req: Request, ctx: RouteContext<"/api/trips/[id]/import">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const b = await readJson(req);
    const raw = str(b.url, 2000) ?? "";
    const rawUrl = firstUrl(raw);
    const url = rawUrl ? normalizeUrl(rawUrl) : null;
    let caption = str(b.caption, 5000) ?? (rawUrl ? raw.replace(rawUrl, "").trim() : raw);
    // share sheets paste "Check out this video! https://…" — that's not a caption
    if (/^(check out|ดูวิดีโอ|ดูคลิป|watch|ดู).{0,60}$/i.test(caption) || caption.length < 12) caption = "";
    const image = typeof b.image === "string" && /^data:image\/(png|jpe?g|webp);base64,/.test(b.image) && b.image.length < 3_000_000 ? b.image : null;
    if (!url && !caption && !image) throw new HttpError(400, "วางลิงก์คลิป แคปชัน หรือแนบภาพแคปหน้าจอ");

    // cache: same URL already imported by anyone in the last 7 days — no AI cost
    if (url && !caption && !image) {
      const [hit] = await sql`select result from pinpai.imports where url = ${url} and status = 'done' and created_at > now() - interval '7 days' order by created_at desc limit 1`;
      if (hit) {
        await sql`insert into pinpai.imports (trip_id, url, platform, caption, result, created_by)
          values (${id}, ${url}, ${hit.result?.platform ?? null}, ${""}, ${sql.json(hit.result as never)}, ${me.id})`.catch(() => {});
        return NextResponse.json(await annotate(hit.result));
      }
    }
    const [trip] = await sql`select destination, dest_lat, dest_lng from pinpai.trips where id = ${id}`;
    const anchor = trip.dest_lat != null ? { lat: trip.dest_lat as number, lng: trip.dest_lng as number } : null;

    // Google Maps link: it already names one exact place — no AI, no cost
    if (url && detectPlatform(url) === "gmaps") {
      const g = await googleMapsPlace(rawUrl!);
      if (!g) throw new HttpError(422, "เปิดลิงก์ Google Maps นี้ไม่ได้ ลองกด “แชร์” จากหน้าสถานที่ใน Google Maps แล้ววางใหม่");
      const near = g.lat != null ? { lat: g.lat, lng: g.lng! } : anchor;
      const hit = g.name ? (await searchPlaces(g.name, near, { limit: 3 })).results.find((h) => g.lat == null || distKm(h, { lat: g.lat!, lng: g.lng! }) < 0.5) : undefined;
      const place = { name: g.name || hit?.name || "ตำแหน่งที่ปักไว้", category: hit?.category && hit.category !== "other" ? hit.category : "attraction", city: null,
        why: "จากลิงก์ Google Maps ที่แชร์มา", confidence: 1, lat: g.lat ?? hit?.lat ?? null, lng: g.lng ?? hit?.lng ?? null, address: hit?.address ?? null, approx: g.lat == null };
      return NextResponse.json(await annotate({ platform: "gmaps", author: null, thumbnail: null, caption: "", destination: null, suggested_days: null, places: [place], source_url: url }));
    }

    await requireHuman(req);
    const meter = await aiBudget(id, "import", req);

    let author: string | null = null, thumb: string | null = null;
    const platform = url ? detectPlatform(url) : image ? "screenshot" : "text";
    if (url) {
      const post = await fetchSocialPost(url);
      caption = [post.caption, caption].filter(Boolean).join("\n");
      author = post.author;
      thumb = post.thumbnailUrl;
    }
    if (!caption && !thumb && !image) {
      throw new HttpError(422, platform === "instagram"
        ? "Instagram ไม่ให้ดึงแคปชันอัตโนมัติ ลองคัดลอกแคปชันมาวาง หรือแนบภาพแคปหน้าจอแทน"
        : platform === "other" ? "ลิงก์นี้ยังไม่รองรับ ใช้ได้กับ TikTok, Reels, YouTube, Facebook, Xiaohongshu, Douyin และ Google Maps หรือคัดลอกแคปชัน/แนบภาพแคปหน้าจอแทน"
        : "ดึงข้อมูลจากลิงก์นี้ไม่ได้ (คลิปอาจเป็นส่วนตัวหรือต้องล็อกอิน) ลองคัดลอกแคปชันมาวาง หรือแนบภาพแคปหน้าจอแทน");
    }

    const ex = await extractPlacesFromPost({
      caption: caption || "(no caption — read the image)",
      author, platform, thumbnailUrl: image ?? thumb, tripDestination: trip.destination,
    }, meter);

    const places = await Promise.all(
      ex.places.filter((p) => p.confidence >= 0.35).map(async (p) => {
        const expected = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : anchor;
        const loc = await resolvePlace(p.name_local ?? p.name, p.city, expected, expected === anchor ? 150 : 40);
        return {
          name: p.name_local && p.name_local !== p.name ? `${p.name_local} (${p.name})` : p.name,
          category: p.category, city: p.city, why: p.why, confidence: p.confidence,
          lat: loc?.lat ?? null, lng: loc?.lng ?? null, address: loc?.address ?? null, approx: loc?.approx ?? true,
        };
      }),
    );
    const result = { platform, author, thumbnail: thumb, caption: caption.slice(0, 600), destination: ex.destination, suggested_days: ex.suggested_days, places, source_url: url };
    await sql`insert into pinpai.imports (trip_id, url, platform, caption, result, created_by)
      values (${id}, ${url}, ${platform}, ${caption.slice(0, 4000)}, ${sql.json(result as never)}, ${me.id})`;
    return NextResponse.json(await annotate(result));
  });

  /** Mark what's already in the trip and what's far from the destination, so the review list starts sensible. */
  async function annotate<R extends { places: { name: string; lat: number | null; lng: number | null }[] }>(r: R) {
    const { id } = await ctx.params;
    const [t] = await sql`select dest_lat::float8 as lat, dest_lng::float8 as lng from pinpai.trips where id = ${id}`;
    const have = await sql`select name, lat::float8 as lat, lng::float8 as lng from pinpai.places where trip_id = ${id}`;
    const n = (s: string) => s.toLowerCase().replace(/[\s()（）\-.,'’]+/g, "");
    return {
      ...r,
      places: r.places.map((p) => {
        const dup = have.some((h) => n(h.name).includes(n(p.name).slice(0, 12)) || n(p.name).includes(n(h.name).slice(0, 12))
          || (h.lat != null && p.lat != null && distKm(h as never, p as never) < 0.12));
        const far = t?.lat != null && p.lat != null ? Math.round(distKm({ lat: t.lat, lng: t.lng }, p as never)) : null;
        return { ...p, duplicate: dup || undefined, far_km: far != null && far > 80 ? far : undefined };
      }),
    };
  }
}

/** The last import I ran in this trip (last 2 h) — so closing the app mid-way doesn't lose the result. */
export async function GET(req: Request, ctx: RouteContext<"/api/trips/[id]/import">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const me = await requireMember(req, id);
    const [row] = await sql`select result, created_at from pinpai.imports where trip_id = ${id} and created_by = ${me.id} and status = 'done'
      and created_at > now() - interval '2 hours' order by created_at desc limit 1`;
    return NextResponse.json(row ? { result: row.result, at: row.created_at } : { result: null });
  });
}

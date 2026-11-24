// Pull caption + cover image from a short-video link without needing the user to log in.
export type SocialPost = {
  platform: "tiktok" | "instagram" | "youtube" | "facebook" | "xhs" | "douyin" | "lemon8" | "threads" | "x" | "gmaps" | "other";
  url: string;
  caption: string;
  author: string | null;
  thumbnailUrl: string | null;
};

export function detectPlatform(url: string): SocialPost["platform"] {
  const h = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  // anchored on a dot boundary: "eviltiktok.com" must not count as TikTok
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return "youtube";
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(h)) return "facebook";
  if (/(^|\.)(xiaohongshu\.com|xhslink\.com)$/.test(h)) return "xhs";
  if (/(^|\.)(douyin\.com|iesdouyin\.com)$/.test(h)) return "douyin";
  if (/(^|\.)lemon8-app\.com$/.test(h)) return "lemon8";
  if (/(^|\.)threads\.(net|com)$/.test(h)) return "threads";
  if (/(^|\.)(x\.com|twitter\.com)$/.test(h)) return "x";
  if (/^(maps\.app\.goo\.gl|goo\.gl)$/.test(h) || /(^|\.)google\.[a-z.]+$/.test(h) && /\/maps/.test((() => { try { return new URL(url).pathname; } catch { return ""; } })())) return "gmaps";
  if (/(^|\.)google\.[a-z.]+$/.test(h)) return "gmaps"; // consent / redirect hops of a maps link
  return "other";
}

/** Same post, same cache key: drop tracking params (share ids, utm, etc.). */
export function normalizeUrl(url: string) {
  try {
    const u = new URL(url);
    const p = detectPlatform(url);
    const keep = p === "youtube" ? ["v"] : p === "facebook" ? ["v", "story_fbid", "id"] : p === "gmaps" ? ["q", "query", "cid", "ftid"] : [];
    for (const k of [...u.searchParams.keys()]) if (!keep.includes(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch { return url; }
}

/** Google Maps link → the one place it points to (no AI needed). Follows maps.app.goo.gl short links. */
export async function googleMapsPlace(url: string): Promise<{ name: string; lat: number | null; lng: number | null } | null> {
  let u = url;
  try {
    for (let hop = 0; hop < 5; hop++) {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:" || detectPlatform(u) !== "gmaps") return null;
      if (/\/maps\/(place|search)\//.test(parsed.pathname) || parsed.searchParams.get("q")) break;
      const r = await fetch(parsed, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000), redirect: "manual" });
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) { u = new URL(loc, parsed).toString(); continue; }
      break;
    }
    const parsed = new URL(u);
    const nameRaw = parsed.pathname.match(/\/maps\/(?:place|search)\/([^/]+)/)?.[1] ?? parsed.searchParams.get("q") ?? "";
    const name = decodeURIComponent(nameRaw.replace(/\+/g, " ")).trim();
    const exact = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/), at = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/), q = name.match(/^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/);
    const ll = exact ?? q ?? at;
    if (!name && !ll) return null;
    return { name: q ? "ตำแหน่งที่ปักไว้" : name, lat: ll ? Number(ll[1]) : null, lng: ll ? Number(ll[2]) : null };
  } catch { return null; }
}

export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0].replace(/[),.]+$/, "") : null;
}

const UA = "Mozilla/5.0 (compatible; PinPaiBot/0.1; +https://pinpai.vercel.app)";

async function getJson(u: string) {
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000), redirect: "follow" });
  if (!r.ok) return null;
  return (await r.json()) as Record<string, string>;
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Fetch only https URLs on known social hosts, re-checking every redirect hop (SSRF guard). */
async function fetchSocial(url: string, headers: Record<string, string>) {
  let u = url;
  for (let hop = 0; hop < 5; hop++) {
    let parsed: URL;
    try { parsed = new URL(u); } catch { return null; }
    if (parsed.protocol !== "https:" || parsed.port || detectPlatform(u) === "other") return null;
    const r = await fetch(parsed, { headers, signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location")!, parsed).toString(); continue; }
    return r;
  }
  return null;
}

/** Generic fallback: read og:description / og:title / og:image from the page HTML. */
async function openGraph(url: string) {
  try {
    const r = await fetchSocial(url, { "User-Agent": "facebookexternalhit/1.1", "Accept-Language": "th,en" });
    if (!r || !r.ok) return null;
    const html = (await r.text()).slice(0, 400_000);
    const meta = (p: string) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, "i"))
        ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, "i"));
      return m ? decodeEntities(m[1]) : null;
    };
    return { title: meta("og:title"), description: meta("og:description") ?? meta("description"), image: meta("og:image") };
  } catch {
    return null;
  }
}

export async function fetchSocialPost(url: string): Promise<SocialPost> {
  const platform = detectPlatform(url);
  let caption = "", author: string | null = null, thumbnailUrl: string | null = null;

  try {
    if (platform === "tiktok") {
      const j = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
      if (j) {
        caption = j.title ?? "";
        author = j.author_name ?? null;
        thumbnailUrl = j.thumbnail_url ?? null;
      }
    } else if (platform === "youtube") {
      const j = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      if (j) {
        caption = j.title ?? "";
        author = j.author_name ?? null;
        thumbnailUrl = j.thumbnail_url ?? null;
      }
    }
  } catch {}

  // Only fetch pages on known social hosts (avoid turning this into an open proxy / SSRF).
  if (caption.length < 40 && platform !== "other") {
    const og = await openGraph(url);
    if (og) {
      const extra = [og.title, og.description].filter(Boolean).join("\n");
      if (extra && !caption.includes(extra)) caption = [caption, extra].filter(Boolean).join("\n");
      thumbnailUrl = thumbnailUrl ?? og.image;
    }
  }
  if (thumbnailUrl && !/^https:\/\//i.test(thumbnailUrl)) thumbnailUrl = null; // passed to the model as a URL
  return { platform, url, caption: caption.trim(), author, thumbnailUrl };
}

import { generateText, Output } from "ai";
import { travelMin, type Calib } from "./retime";
import { z } from "zod";

// Vercel AI Gateway (AI_GATEWAY_API_KEY or the deployment's OIDC token).
// Cheapest capable models first. If the account can't use one (e.g. free tier restrictions),
// fall through to the next and remember the one that works for this server instance.
const MODELS = (process.env.PINPAI_MODELS ?? "anthropic/claude-haiku-5.5,google/gemini-2.5-flash-lite,google/gemini-2.5-flash,alibaba/qwen3.7-flash,deepseek/deepseek-v4-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
// USD per 1M tokens [in, out] for metering (≤100k-token tier)
const PRICES: Record<string, [number, number]> = {
  "anthropic/claude-haiku-5.5": [0.1, 0.5],
  "google/gemini-2.5-flash-lite": [0.1, 0.4],
  "google/gemini-2.5-flash": [0.3, 2.5],
  "alibaba/qwen3.7-flash": [0.03, 0.13],
  "deepseek/deepseek-v4-flash": [0.13, 0.26],
};
let modelIdx = 0;
export const activeModel = () => MODELS[Math.min(modelIdx, MODELS.length - 1)];
const MODEL = "__chain__"; // placeholder; gen() picks the real model
// economy mode: the month's AI spend is near the cap → cheapest models first, so planning keeps working instead of switching off
let economy = false;
export const setEconomy = (on: boolean) => { economy = on; };
const priceOf = (m: string) => { const [i, o] = PRICES[m] ?? [0.5, 2]; return i + 3 * o; };

export type Usage = { inputTokens?: number; outputTokens?: number; cost?: number; model?: string };
export type Meter = (u: Usage) => Promise<void> | void;
type Gen = Parameters<typeof generateText>[0];

function modelUnavailable(e: unknown) {
  const m = String((e as Error)?.message ?? "") + JSON.stringify((e as { cause?: unknown })?.cause ?? "");
  return /do not have access to this model|no_providers_available|RestrictedModels|model.*not (found|supported)|not available|too many states|schema/i.test(m);
}

function rateLimited(e: unknown) {
  const m = String((e as Error)?.message ?? "") + JSON.stringify((e as { errors?: unknown; cause?: unknown })?.errors ?? (e as { cause?: unknown })?.cause ?? "");
  return /rate.?limit|429|too many requests|overloaded|timeout|ETIMEDOUT|ECONNRESET|503|502/i.test(m);
}
const cooldown = new Map<string, number>(); // model → epoch ms it may be used again (free tier: ~5 req/min per model)

/** generateText with model fallback + token/cost reporting to the caller's meter.
 *  Unavailable models are skipped for good; rate-limited ones are skipped for a minute and the next model answers. */
async function gen<T>(opts: Gen, meter?: Meter): Promise<T> {
  let lastErr: unknown;
  const base = economy ? [...MODELS.slice(modelIdx)].sort((a, b) => priceOf(a) - priceOf(b)) : MODELS.slice(modelIdx);
  const order = base.sort((a, b) => Number((cooldown.get(a) ?? 0) > Date.now()) - Number((cooldown.get(b) ?? 0) > Date.now()));
  for (const model of order) {
    try {
      // gemini "thinks" out of the same token budget and then truncates the JSON → turn thinking off for structured output
      const prov = model.startsWith("google/") ? { providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } } : {};
      const r = await generateText({ maxRetries: 0, ...prov, ...opts, model } as Gen);
      const inT = r.usage?.inputTokens ?? 0, outT = r.usage?.outputTokens ?? 0;
      const [pi, po] = PRICES[model] ?? [0.5, 2];
      await meter?.({ inputTokens: inT, outputTokens: outT, cost: (inT * pi + outT * po) / 1e6, model });
      return (r as unknown as { output: T }).output;
    } catch (e) {
      lastErr = e;
      if (modelUnavailable(e)) {
        const i = MODELS.indexOf(model);
        if (i === modelIdx) modelIdx = Math.min(MODELS.length - 1, i + 1);
        console.warn(`[ai] ${model} unavailable for this account, trying next`);
      } else if (/No ?Object ?Generated|could not parse|did not match schema|JSON/i.test(String((e as Error)?.name) + String((e as Error)?.message))) {
        console.warn(`[ai] ${model} returned unusable JSON, trying next`); // e.g. output cut off — another model usually manages
      } else if (rateLimited(e)) {
        cooldown.set(model, Date.now() + 60_000);
        console.warn(`[ai] ${model} rate-limited, trying next`);
      } else throw e;
    }
  }
  throw lastErr;
}

export const CATEGORIES = ["attraction", "food", "cafe", "stay", "shopping", "nightlife", "nature", "transport", "other"] as const;

const extractedPlace = z.object({
  name: z.string().describe("Specific place/business name as locals would search it on a map"),
  name_local: z.string().nullable().describe("Name in local script if different (e.g. Thai, Japanese)"),
  city: z.string().nullable().describe("City / area the place is in"),
  category: z.enum(CATEGORIES),
  lat: z.number().nullable().describe("Best-guess latitude, null if unknown"),
  lng: z.number().nullable().describe("Best-guess longitude, null if unknown"),
  why: z.string().describe("One short line in Thai: what the video says about it / why go"),
  confidence: z.number().describe("0 to 1"),
});

export const extractionSchema = z.object({
  destination: z.string().nullable().describe("Overall destination of the video, e.g. 'Chiang Mai, Thailand'"),
  suggested_days: z.number().nullable(),
  places: z.array(extractedPlace).describe("at most 20"),
});
export type Extraction = z.infer<typeof extractionSchema>;

export async function extractPlacesFromPost(input: {
  caption: string;
  author?: string | null;
  platform: string;
  thumbnailUrl?: string | null;
  tripDestination?: string | null;
}, meter?: Meter): Promise<Extraction> {
  const text = [
    `Platform: ${input.platform}`,
    input.author ? `Creator: ${input.author}` : "",
    input.tripDestination ? `The user's trip destination: ${input.tripDestination}` : "",
    `Caption / description:\n"""${input.caption.slice(0, 4000)}"""`,
  ].filter(Boolean).join("\n");

  const content: ({ type: "text"; text: string } | { type: "file"; data: URL; mediaType: string })[] = [{ type: "text", text }];
  if (input.thumbnailUrl) {
    try {
      content.push({ type: "file", data: new URL(input.thumbnailUrl), mediaType: "image/jpeg" });
    } catch {}
  }

  const run = (withImage: boolean) =>
    gen<Extraction>({
      model: MODEL,
      instructions:
        "You extract real, visitable places (attractions, restaurants, cafes, hotels, markets, viewpoints) from short travel videos' captions and cover images. " +
        "Only include places that are actually named or unambiguously identifiable. Do not invent places. " +
        "Read on-screen text in the cover image if present. Hashtags often contain place names. " +
        "Write `why` in natural Thai. Keep names searchable on OpenStreetMap / Google Maps.",
      messages: [{ role: "user", content: withImage ? content : content.slice(0, 1) }],
      output: Output.object({ schema: extractionSchema }),
      maxOutputTokens: 1800,
    }, meter);

  const clip = (e: Extraction): Extraction => ({ ...e, places: e.places.slice(0, 20).map((p) => ({ ...p, confidence: Math.max(0, Math.min(1, p.confidence ?? 0.5)) })) });
  try {
    return clip(await run(content.length > 1));
  } catch (e) {
    if (content.length > 1 && !isGatewayDown(e)) return clip(await run(false)); // thumbnail fetch may fail (expired CDN url)
    throw e;
  }
}

export const detailsSchema = z.object({
  summary: z.string().describe("2 sentences in Thai: what it is and why it's worth it"),
  highlights: z.array(z.string()).describe("Thai, short bullets: what to see/do/order"),
  tips: z.array(z.string()).describe("Thai, practical insider tips: queues, dress code, cash only, photo spot..."),
  best_time: z.string().nullable().describe("Thai, e.g. 'เช้า 7–9 โมง คนน้อย'"),
  duration_min: z.number().nullable().describe("Typical visit length in minutes"),
  price: z.string().nullable().describe("Thai, entrance fee or price per person, with currency"),
  hours: z.string().nullable().describe("Typical opening hours; say 'ควรเช็กก่อนไป' if unsure"),
  getting_there: z.string().nullable().describe("Thai, one line"),
  must_try: z.array(z.string()).nullable().describe("For food/cafe: signature dishes in Thai"),
});
export type PlaceDetails = z.infer<typeof detailsSchema>;

export async function describePlace(p: { name: string; category: string; address?: string | null; destination?: string | null }, meter?: Meter) {
  const d = await gen<PlaceDetails>({
    model: MODEL,
    instructions:
      "You are a concise Thai travel guide. Give compact, practical, accurate info. " +
      "If you are not confident about a fact (hours, prices), say so briefly in Thai rather than guessing precisely.",
    prompt: `Place: ${p.name}\nCategory: ${p.category}\nAddress: ${p.address ?? "-"}\nTrip destination: ${p.destination ?? "-"}`,
    output: Output.object({ schema: detailsSchema }),
    maxOutputTokens: 900,
  }, meter);
  return { ...d, highlights: (d.highlights ?? []).slice(0, 4), tips: (d.tips ?? []).slice(0, 4), must_try: d.must_try ? d.must_try.slice(0, 4) : null };
}

export const recommendSchema = z.object({
  places: z.array(extractedPlace).describe("8 places"),
});

export async function recommendPlaces(opts: {
  destination: string;
  kind: "food" | "attraction" | "cafe" | "nightlife";
  near?: string | null;
  exclude: string[];
  note?: string | null;
}, meter?: Meter) {
  const kindTh = { food: "ร้านอาหารท้องถิ่นที่คนพื้นที่กินจริง", attraction: "ที่เที่ยวเด่นและที่เที่ยวลับ", cafe: "คาเฟ่", nightlife: "ที่เที่ยวกลางคืน/บาร์" }[opts.kind];
  const output = await gen<z.infer<typeof recommendSchema>>({
    model: MODEL,
    instructions:
      "You recommend real, currently-operating places for Thai travelers. Mix famous must-visits with well-loved local spots. " +
      "Never recommend places you are unsure exist. Provide best-guess coordinates. Write `why` in Thai (one line).",
    prompt:
      `Destination: ${opts.destination}\nWant: 8 ${kindTh}\n` +
      (opts.near ? `Prefer places near: ${opts.near}\n` : "") +
      (opts.note ? `Group preference: ${opts.note}\n` : "") +
      (opts.exclude.length ? `Already in plan (exclude): ${opts.exclude.slice(0, 60).join(", ")}` : ""),
    output: Output.object({ schema: recommendSchema }),
    maxOutputTokens: 1800,
  }, meter);
  return output.places.slice(0, 10);
}

const suggestSchema = z.object({ places: z.array(extractedPlace).describe("6 places") });
/** A few real places right around one point (gap filler / missing meal / "near here"). */
export async function suggestNearby(opts: {
  destination: string; kind: "food" | "cafe" | "attraction"; lat: number; lng: number; label?: string | null;
  meal?: string | null; at?: string | null; food?: string[]; companions?: string | null; exclude: string[];
}, meter?: Meter) {
  const kindTh = { food: "ร้านอาหารที่คนพื้นที่กินจริง (ร้านมีชื่อ ไม่ใช่ศูนย์อาหารทั่วไป)", cafe: "คาเฟ่ / ร้านขนม", attraction: "ที่เที่ยว จุดถ่ายรูป หรือกิจกรรมสั้นๆ" }[opts.kind];
  const meal = opts.meal ? { breakfast: "breakfast (open early morning)", lunch: "lunch", dinner: "dinner", snack: "afternoon snack/dessert", late: "late-night food" }[opts.meal] ?? null : null;
  const food = (opts.food ?? []).map((f) => ({ local: "signature local dishes", street: "street food ok", famous: "famous/Michelin", seafood: "seafood", thai: "Thai food", mild: "NOT spicy options", halal: "HALAL only", veg: "vegetarian-friendly only" }[f])).filter(Boolean);
  const output = await gen<z.infer<typeof suggestSchema>>({
    model: MODEL,
    instructions:
      "You suggest real, currently-operating places within walking or short-ride distance (ideally under 1.5 km, never over 3 km) of a given point, for Thai travellers. " +
      "Never suggest a place you are not sure exists or is far away. Give accurate coordinates. Write `why` in Thai (one short line, what to order/see).",
    prompt:
      `Destination: ${opts.destination}\nPoint: ${opts.label ? `${opts.label} ` : ""}(${opts.lat.toFixed(5)}, ${opts.lng.toFixed(5)})\nWant: 6 ${kindTh}\n` +
      (meal ? `For: ${meal}${opts.at ? ` around ${opts.at}` : ""} — must be open then\n` : opts.at ? `Visiting around ${opts.at} — must be open then\n` : "") +
      (opts.kind !== "attraction" && food.length ? `Food preference: ${food.join("; ")}\n` : "") +
      (opts.companions === "date" ? "Travelling as a couple on a date\n" : opts.companions === "family" ? "Travelling with family (kids/elderly)\n" : "") +
      (opts.exclude.length ? `Exclude (already in plan): ${opts.exclude.slice(0, 50).join(", ")}` : ""),
    output: Output.object({ schema: suggestSchema }),
    maxOutputTokens: 1400,
  }, meter);
  return output.places.slice(0, 8);
}

/** Checks the route runs again on the REAL pins and final times (the model's own coordinates and times can't be trusted). */
export const stopRules = {
  noSpicy: (note?: string | null, food?: string[]) => (food ?? []).includes("mild") || NO_SPICY.test(note ?? ""),
  spicy: (name: string) => SPICY.test(name),
  daytimeOnly: (name: string) => DAYTIME_ONLY.test(name),
  generic: (name: string) => GENERIC.test(name.replace(/\s*\(.*\)\s*$/, "").trim()) || /^(local|street|hotel|nearby|a |any )?\s*(breakfast|lunch|dinner|cafe|coffee|food|restaurant|food court|noodle|tea house)( stall| shop| spot| place| restaurant| for breakfast| near.*)?$/i.test(name.replace(/^.*\(([^)]*)\)\s*$/, "$1").trim()),
};

/** Restaurants for specific slots around REAL map points (used after geocoding, when the planned restaurant turned out to be across town). */
export async function mealsNear(input: { destination: string; companions?: string; food?: string[]; note?: string | null },
  slots: { day: number; meal: string; around: string }[], meter?: Meter) {
  const food = [...(input.food ?? []), ...(NO_SPICY.test(input.note ?? "") ? ["mild"] : [])];
  return fillMeals({ destination: input.destination, companions: input.companions, food }, slots, meter);
}

/** True when the AI provider/gateway refuses service (no credits, card, budget) — not worth retrying. */
export function isGatewayDown(e: unknown) {
  const m = String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? "");
  const st = (e as { statusCode?: number })?.statusCode;
  return st === 401 || st === 402 || st === 403 || st === 429 || /credit card|insufficient|budget|quota|customer_verification/i.test(m);
}

const identifySchema = z.object({ places: z.array(extractedPlace).describe("at most 4") });
/** Map a fuzzy user query (transliterated, nickname, local stall) to up to 4 real places. */
export async function identifyPlaces(q: string, destination: string | null, meter?: Meter) {
  const out = await gen<z.infer<typeof identifySchema>>({
    model: MODEL,
    instructions:
      "The user typed a place they want to visit; it may be a Thai transliteration of a foreign name, a nickname, a misspelling, or a small local food stall. " +
      "Return the most likely real places (best match first, max 4) with their official/searchable name in `name`, the local-script name in `name_local` " +
      "(Thai for Thailand, Japanese for Japan…), best-guess coordinates, and a one-line Thai `why`. Never invent places; return an empty list if unsure.",
    prompt: `Query: ${q}\nTrip destination: ${destination ?? "unknown"}`,
    output: Output.object({ schema: identifySchema }),
    maxOutputTokens: 700,
  }, meter);
  return out.places.filter((p) => (p.confidence ?? 0.5) >= 0.4).slice(0, 4);
}

// ---------- full trip planner ----------
const planStop = z.object({
  name: z.string().describe("Searchable official name (English or romanized)"),
  name_local: z.string().nullable().describe("Name in local script (Thai in Thailand, Chinese in China, Japanese in Japan…)"),
  category: z.enum(CATEGORIES),
  start_time: z.string().describe("HH:MM 24h"),
  duration_min: z.number(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  why: z.string().describe("One short Thai line: why go / what to do or eat"),
});
const DUR: Record<string, [number, number]> = { food: [40, 100], cafe: [30, 75], attraction: [45, 240], nature: [45, 240], shopping: [45, 150], nightlife: [60, 150], other: [30, 120] };
const toMin = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? ""); return m ? +m[1] * 60 + +m[2] : null; };
const toHHMM = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const BIG = /disney|universal|theme ?park|amusement|legoland|safari world|chimelong|lotte world|everland|aquarium|zoo|สวนสนุก|ดรีมเวิลด์|ซาฟารี|สวนสัตว์|ธีมพาร์ค|อควาเรียม/i;
/** Keep the AI honest: chronological, sane durations, no overlaps (15 min buffer for travel).
 *  Meals inside a theme-park block keep their time (you eat in the park). */
type Geo = { lat?: number | null; lng?: number | null };
const dist = (a: Geo, b: Geo) => (a.lat == null || b.lat == null || a.lng == null || b.lng == null ? null
  : 12742 * Math.asin(Math.sqrt(Math.sin(((b.lat - a.lat) * Math.PI) / 360) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(((b.lng - a.lng) * Math.PI) / 360) ** 2)));
export function fixSchedule<T extends { start_time: string; duration_min: number; category: string; name?: string } & Geo>(stops: T[]): T[] {
  const withT = stops.map((s, i) => ({ s, i, t: toMin(s.start_time) }));
  withT.sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9) || a.i - b.i);
  let free = -1, bigFrom = -1, bigTo = -1;
  let big0: T | null = null, prev: T | null = null;
  const out: T[] = [];
  for (const { s, t } of withT) {
    const [lo, hiBase] = DUR[s.category] ?? DUR.other;
    const big = BIG.test(String(s.name ?? "")) && (s.category === "attraction" || s.category === "nature");
    const hi = big ? 540 : hiBase;
    const dur = Math.min(hi, Math.max(lo, Math.round(Number(s.duration_min) || lo)));
    const eat = s.category === "food" || s.category === "cafe";
    if (eat && t != null && t >= bigFrom && t < bigTo) {
      const d = big0 ? dist(big0, s) : null;
      if (d == null || d < 2) out.push({ ...s, start_time: toHHMM(t), duration_min: dur }); // eating inside the park
      continue; // a meal across town in the middle of a park day is impossible → drop (gap filler adds one in the park)
    }
    // travel time grows with distance (city average ~25 km/h door to door)
    const hop = prev ? dist(prev, s) : null;
    // AI coordinates can be far off, so this pass only keeps order and sane gaps; settleDay() redoes it from the real pins
    const buffer = hop == null ? 15 : Math.min(40, Math.max(10, Math.round(hop * 2.5) + 5));
    let start = t ?? (free >= 0 ? free + buffer : 9 * 60);
    if (free >= 0 && start < free + buffer) start = Math.ceil((free + buffer) / 5) * 5;
    if (start > 23 * 60 + 30) continue; // the day is full — never push a stop past midnight (it would wrap to "00:30")
    free = start + dur;
    if (big) { bigFrom = start; bigTo = start + dur; big0 = s; }
    prev = s;
    out.push({ ...s, start_time: toHHMM(start), duration_min: dur });
  }
  return out;
}

const MEAL_WIN: Record<string, [number, number, string]> = {
  breakfast: [420, 570, "breakfast 07:00-09:30 near the hotel or first stop — a place that really serves breakfast and is open then"], lunch: [660, 840, "lunch 11:00-14:00"],
  dinner: [1050, 1230, "dinner 17:30-20:30"], snack: [840, 1020, "café / dessert 14:00-17:00"], late: [1230, 1440, "late-night food 20:30-24:00"],
};
const GENERIC = /^(breakfast|brunch|lunch|dinner|supper|snack|meal|อาหาร(เช้า|กลางวัน|เที่ยง|เย็น|ว่าง|ค่ำ)|มื้อ|ร้านอาหาร(ใกล้|แถว))|near (the )?(hotel|park)|nearby|at (the )?hotel|hotel.{0,24}breakfast|酒店.{0,12}早餐|酒店自助|breakfast buffet|อาหารเช้า(ที่|ใน)?โรงแรม|ห้องอาหารโรงแรม|ใกล้ที่พัก|ใกล้โรงแรม|แถวที่พัก|ในโรงแรม|ที่โรงแรม|^ร้าน(อาหาร|กาแฟ)?(ท้องถิ่น|แถว|ใกล้)|inside .*park/i;
const PSEUDO = /check.?in|check.?out|เช็ค ?อิน|เช็ค ?เอา?้?ท์|เข้าที่พัก|พักผ่อนที่โรงแรม|rest at (the )?hotel|free time|เวลาอิสระ|^(grab|taxi|didi|bolt|uber|transfer|shuttle|drive|go|head|return|back)\b.*\b(to|back to)\b.*(hotel|accommodation|airport)|(กลับ|เดินทางไป|นั่งรถไป|เดินทางกลับ)(ที่พัก|โรงแรม)|^(travel|transfer|เดินทาง)$/i;
const NO_SPICY = /ไม่(กิน|ทาน|ชอบ)?เผ็ด|แพ้เผ็ด|กินเผ็ดไม่ได้|no spicy|not spicy|non.?spicy|can'?t eat spicy/i;
const SPICY = /sichuan|szechuan|川菜|四川|เสฉวน|hunan|湘菜|หูหนาน|chongqing|重庆|ฉงชิ่ง|mala|麻辣|หม่าล่า|hot ?pot|火锅|หม้อไฟ|haidilao|海底捞|yunnan|云南|ยูนนาน|lost heaven|花马天堂|spicy|เผ็ด(?!น้อย)/i;
const DAYTIME_ONLY = /temple|寺|庙|วัด|museum|博物馆|美术馆|พิพิธภัณฑ์|gallery|garden|园林|豫园|สวนจีน|palace|故居|former residence|residence of|memorial|纪念馆|art cent(er|re)|poster/i;
const DECK = /observation|observatory|sky ?(deck|walk|tree)|tower|大厦|明珠|电视塔|金融中心|financial cent(er|re)|จุดชมวิว|หอคอย/i;
// places nobody eats breakfast at
const NOT_BREAKFAST = /hot ?pot|火锅|หม้อไฟ|ชาบู|shabu|หมูกระทะ|bbq|barbecue|烧烤|ปิ้งย่าง|yakiniku|izakaya|居酒屋|\bbar\b|บาร์|pub|steak|สเต็ก|omakase|โอมากาเสะ|din tai fung|鼎泰[丰豐]|buffet dinner|rooftop|haidilao|海底捞|peking duck|烤鸭/i;
type Stop = z.infer<typeof planStop>;
// "Breakfast at Kaosoi Khun Yai" → "Kaosoi Khun Yai" (keeps the real place, drops the meal label)
const MEAL_PREFIX = /^\s*((breakfast|brunch|lunch|dinner|supper)\s+(at|@)\s+|(อาหาร|มื้อ)(เช้า|กลางวัน|เที่ยง|เย็น|ค่ำ|ดึก)(\s*(ที่|ร้าน)\s*|\s+(?=\S)))/i;
// "Morning Run: Buak Haad Park" / "Dinner: Pla Too 99" → the place itself
const LABEL_PREFIX = /^\s*[A-Za-z][A-Za-z &'-]{2,28}:\s+(?=\S)|^\s*(วิ่ง|นวด|ช้อปปิ้ง|เดินเล่น|ชม|เที่ยว|กิน|ทาน)[^:：]{0,18}[:：]\s*(?=\S)/;
function cleanName<S extends { name: string; name_local: string | null }>(x: S): S {
  const strip = (v: string) => v.replace(MEAL_PREFIX, "").replace(LABEL_PREFIX, "").trim();
  const n = strip(x.name), l = x.name_local ? strip(x.name_local) : null;
  return { ...x, name: n.length > 1 ? n : x.name, name_local: l && l.length > 1 ? l : x.name_local };
}
/**
 * Final timetable for one day, computed from the real map pins (not the AI's guessed coordinates):
 * every stop starts after the previous one ends plus realistic travel; when that would push a meal out of its
 * window, the sightseeing before it is shortened (never below a sensible minimum) instead of eating lunch at 5 pm.
 */
export function settleDay<T extends { start_time: string | null; duration_min: number | null; category: string; name: string; lat: number | null; lng: number | null; fixed?: boolean }>(
  stops: T[], opts: { endBy?: number | null; mode?: string; pinHub?: boolean; calib?: Calib | null } = {},
): T[] {
  const n = stops.length;
  if (!n) return stops;
  const t0 = stops.map((s) => (s.start_time ? toMin(s.start_time) : null));
  if (t0.filter((t) => t != null).length < 2) return stops;
  const big = (s: T) => BIG.test(s.name) && (s.category === "attraction" || s.category === "nature");
  const lo = stops.map((s) => (big(s) ? 240 : (DUR[s.category] ?? DUR.other)[0]));
  const dur = stops.map((s, i) => Math.max(lo[i], Math.round(Number(s.duration_min) || lo[i])));
  const eat = stops.map((s) => s.category === "food" || s.category === "cafe");
  // same travel model as the editor and the route legs (lib/retime), so planned times match what people see
  const travel = stops.map((s, i) => (i === 0 ? 0 : travelMin(stops[i - 1], s, opts.mode, opts.calib)));
  // the meal window a food stop was planned for
  const winEnd = stops.map((_, i) => {
    if (!eat[i] || t0[i] == null) return null;
    const w = Object.values(MEAL_WIN).find(([a, b]) => t0[i]! >= a - 30 && t0[i]! <= b);
    return w ? w[1] : null;
  });
  let start: number[] = [];
  const inside = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      if (!big(stops[j]) || t0[j] == null) continue;
      const a = stops[j], b = stops[i];
      const near = a.lat == null || b.lat == null || a.lng == null || b.lng == null || dist({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng })! < 3;
      return near && t0[i]! < t0[j]! + dur[j] ? j : -1;
    }
    return -1;
  };
  const pass = () => {
    let free = -1; start = [];
    for (let i = 0; i < n; i++) {
      // lunch inside a theme park happens during the park visit: it neither waits for the park to "end" nor shortens it
      const host = eat[i] && t0[i] != null ? inside(i) : -1;
      if (host >= 0) { start.push(Math.max(t0[i]!, start[host] + 60)); free = Math.max(free, start[i] + dur[i]); continue; }
      let st = t0[i] ?? (free >= 0 ? free + travel[i] : 9 * 60);
      // a time the group locked (booking, show) never moves
      if (free >= 0 && st < free + travel[i] && !(stops[i].fixed && t0[i] != null)) st = Math.ceil((free + travel[i]) / 5) * 5;
      start.push(st); free = st + dur[i];
    }
  };
  for (let round = 0; round < 8; round++) {
    pass();
    const late = start.findIndex((st, i) => winEnd[i] != null && st > winEnd[i]! + 15 && inside(i) < 0);
    if (late < 0) break;
    let over = start[late] - winEnd[late]!;
    let cut = false;
    for (let j = late - 1; j >= 0 && over > 0 && !eat[j] && !stops[j].fixed; j--) {
      const slack = dur[j] - lo[j];
      if (slack <= 0) continue;
      const take = Math.min(slack, Math.ceil(over / 5) * 5);
      dur[j] -= take; over -= take; cut = true;
    }
    if (!cut) { winEnd[late] = null; } // nothing left to shorten: accept the late meal
  }
  pass();
  // departure with a known time: the airport/station is fixed at endBy; whatever can't finish and get there in time goes
  const gone = new Set<number>();
  const hub = opts.pinHub && opts.endBy != null ? stops.map((s, i) => (s.category === "transport" && t0[i] != null ? i : -1)).filter((i) => i > 0).pop() : undefined;
  if (hub != null && opts.endBy != null) {
    start[hub] = opts.endBy;
    for (let i = hub - 1; i >= 0; i--) {
      if (t0[i] == null) continue;
      const a = stops[i], h = stops[hub];
      const road = a.lat != null && a.lng != null && h.lat != null && h.lng != null ? dist({ lat: a.lat, lng: a.lng }, { lat: h.lat, lng: h.lng })! * 1.3 : 20;
      const tr = Math.min(150, Math.round((road / (road > 25 ? 45 : 24)) * 60) + 10);
      const room = opts.endBy - tr - start[i];
      if (room >= lo[i]) { dur[i] = Math.min(dur[i], Math.floor(room / 5) * 5); break; }
      if (!stops[i].fixed) gone.add(i);
    }
  }
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    if (gone.has(i)) continue;
    if (t0[i] == null) { out.push(stops[i]); continue; }
    if (start[i] > 23 * 60 + 30 && !stops[i].fixed) continue;
    // last day: nothing new starts after it is time to head to the airport (the airport/station itself stays)
    if (opts.endBy != null && start[i] > opts.endBy && stops[i].category !== "transport" && !stops[i].fixed) continue;
    out.push({ ...stops[i], start_time: toHHMM(start[i]), duration_min: dur[i] });
  }
  return out;
}

/** Find meals that are missing or only placeholders ("Breakfast near hotel"). */
export function mealGaps(days: { day: number; stops: Stop[] }[], meals: string[], nDays: number) {
  const gaps: { day: number; meal: string; around: string; replace?: string }[] = [];
  for (const d of days) {
    const real = d.stops.filter((x) => !GENERIC.test(x.name));
    const times = real.map((x) => toMin(x.start_time)).filter((x): x is number => x != null);
    const from = d.day === 0 ? Math.min(...times, 24 * 60) : 0, to = d.day === nDays - 1 ? Math.max(...times.map((t) => t + 60), 0) : 24 * 60;
    // a meal that drags everyone across town and back (zig-zag) gets replaced by one near its neighbours
    real.forEach((x, i) => {
      if (x.category !== "food" && x.category !== "cafe") return;
      const p = real[i - 1], n = real[i + 1];
      const a = p ? dist(p, x) : null, b = n ? dist(x, n) : null, pn = p && n ? dist(p, n) : null;
      if (a != null && b != null && pn != null && a > 3 && b > 3 && pn < Math.min(a, b)) {
        const meal = Object.entries(MEAL_WIN).find(([, [lo, hi]]) => { const t = toMin(x.start_time) ?? -1; return t >= lo - 20 && t <= hi; })?.[0];
        if (meal && meals.includes(meal)) { gaps.push({ day: d.day, meal, around: `${p!.name} (${p!.lat},${p!.lng})`, replace: x.name }); (x as { _detour?: boolean })._detour = true; }
      }
    });
    // hot pot at 07:00 is not breakfast → have it replaced by a real breakfast place
    if (meals.includes("breakfast")) for (const x of real) {
      const t = toMin(x.start_time) ?? -1;
      if ((x.category === "food" || x.category === "cafe") && t >= 6 * 60 && t <= 9 * 60 + 30 && NOT_BREAKFAST.test(`${x.name} ${x.name_local ?? ""}`) && !(x as { _detour?: boolean })._detour) {
        const nb = real.find((y) => y !== x && y.lat != null);
        gaps.push({ day: d.day, meal: "breakfast", around: nb ? `${nb.name} (${nb.lat},${nb.lng})` : "the hotel", replace: x.name }); (x as { _detour?: boolean })._detour = true;
      }
    }
    for (const m of meals) {
      const [a, b] = MEAL_WIN[m] ?? [0, 0];
      if (b <= from + 60 || a >= to - 30) continue; // not around on arrival / departure day
      const ok = real.some((x) => !(x as { _detour?: boolean })._detour && (x.category === "food" || x.category === "cafe" || (m === "late" && x.category === "nightlife")) && (toMin(x.start_time) ?? -1) >= a - 20 && (toMin(x.start_time) ?? 9e9) <= b);
      if (!ok && !gaps.some((g) => g.day === d.day && g.meal === m)) {
        const near = real.filter((x) => x.lat != null).sort((p, q) => Math.abs((toMin(p.start_time) ?? 0) - a) - Math.abs((toMin(q.start_time) ?? 0) - a))[0];
        gaps.push({ day: d.day, meal: m, around: near ? `${near.name} (${near.lat},${near.lng})` : "the hotel" });
      }
    }
  }
  return gaps;
}
const fillSchema = z.object({ meals: z.array(planStop.extend({ day: z.number().describe("0-based day index"), meal: z.string() })) });
async function fillMeals(input: { destination: string; companions?: string; food?: string[] }, gaps: ReturnType<typeof mealGaps>, meter?: Meter, activity = false) {
  const out = await gen<z.infer<typeof fillSchema>>({
    model: MODEL,
    instructions: activity
      ? "You are a Thai tour leader adding requested activities to an itinerary. For every item, name ONE real, currently operating venue for that activity (a specific park or riverside path, spa, theatre, trail…) close to the given anchor, with accurate coordinates. name = the venue's own name only. Thai text for why, saying it is the activity the group asked for."
      : "You are a Thai tour leader fixing an itinerary. For every gap, name ONE real, currently operating, well-reviewed restaurant or café (never a generic placeholder, never 'hotel breakfast') close to the given anchor, open at that time. Thai text for why.",
    prompt: `Destination: ${input.destination}\nGroup: ${input.companions ?? "friends"}${input.food?.length ? `\nFood focus: ${input.food.join(", ")}` : ""}\nGaps:\n` +
      gaps.map((g) => `- day ${g.day}: ${MEAL_WIN[g.meal]?.[2] ?? g.meal}, near ${g.around}`).join("\n"),
    output: Output.object({ schema: fillSchema }),
    maxOutputTokens: 3600,
  }, meter);
  const mild = (input.food ?? []).includes("mild");
  return mild ? out.meals.filter((m) => !SPICY.test(`${m.name} ${m.name_local ?? ""}`)) : out.meals;
}


const planSchema = z.object({
  summary: z.string().describe("Thai, 2 sentences: the shape of the trip"),
  getting_there: z.string().describe("Thai, max 3 short sentences: how to get there from Thailand / the airport or station into town, with realistic options and rough cost"),
  getting_around: z.string().describe("Thai, max 3 short sentences: best local transport for this trip (metro, bus, Grab/Didi, scooter…) and passes worth buying"),
  stays: z.array(z.object({
    name: z.string(), name_local: z.string().nullable(), area: z.string().describe("Neighbourhood, Thai"),
    lat: z.number().nullable(), lng: z.number().nullable(),
    check_in_day: z.number().describe("0-based day index"), nights: z.number(),
    price: z.string().describe("Thai, price per night range in THB"), why: z.string().describe("Thai, one line"),
  })).describe("1-2 hotels covering every night, located central to that part of the plan"),
  days: z.array(z.object({
    day: z.number().describe("0-based"),
    theme: z.string().describe("Thai, short title for the day"),
    stops: z.array(planStop),
  })),
  tips: z.array(z.string()).describe("Thai, 3-5 practical tips on the ground: dress code, closing days, queues, scams, tipping"),
  prep: z.array(z.string()).describe("Thai checklist of 6-8 short lines (max ~90 chars each) of things to DO BEFORE leaving, specific to this destination and a Thai passport holder: entry/visa rule and documents; eSIM or SIM; apps that actually work there for maps, taxi, translation and payment; cash vs mobile payment and how much to carry; power plug type; which stops in THIS plan need tickets booked ahead (name them); clothes for the weather on these dates; the local emergency number (short number only); for the Thai embassy/consulate say to look up the current phone on the official site — never write long phone numbers"),
  costs: z.object({
    stay_per_night: z.number().describe("THB per room per night for the suggested hotels"),
    food_per_day: z.number().describe("THB per person per day for the planned meals and snacks"),
    local_transport_per_day: z.number().describe("THB per person per day getting around with the chosen mode"),
    tickets_total: z.number().describe("THB per person: entry fees for all planned stops"),
    flights: z.number().describe("THB per person round trip from Bangkok; 0 if reachable by land within Thailand"),
    note: z.string().describe("Thai, one line on where to save or what drives the cost"),
  }).describe("Realistic per-person estimates in Thai baht for this exact plan"),
});
export type TripPlan = z.infer<typeof planSchema>;

const WANT_EN: Record<string, string> = {
  run: "a morning RUN at a real, named running spot (a specific park, riverside greenway or lakeside loop — give its proper name, never a generic label like \"running track\")", massage: "a massage or spa session", hike: "a hike or nature walk",
  bike: "a bicycle ride (rental + route)", onsen: "hot spring / onsen / bathhouse", beach: "beach or swimming time", show: "a live show, performance or concert",
  cooking: "a cooking class or hands-on workshop", sunrise: "a sunrise viewpoint", sunset: "a sunset viewpoint or rooftop", museum: "a museum or gallery", kids: "something fun for kids",
};
const WANT_TH: Record<string, string> = { run: "วิ่งตอนเช้า (run)", massage: "นวด/สปา (massage)", hike: "เดินป่า (hike)", bike: "ปั่นจักรยาน (bike)", onsen: "ออนเซ็น", beach: "ทะเล (beach)",
  show: "ดูโชว์ (show)", cooking: "เวิร์กช็อป (workshop)", sunrise: "ดูพระอาทิตย์ขึ้น (sunrise)", sunset: "ดูพระอาทิตย์ตก (sunset)", museum: "พิพิธภัณฑ์ (museum)", kids: "กิจกรรมเด็ก (kids)" };
const WANT_RE: Record<string, RegExp> = {
  run: /วิ่ง|\brun|jog/i, massage: /นวด|massage|\bspa\b|สปา|按摩/i, hike: /เดินป่า|เดินเขา|hik|trek|trail/i, bike: /ปั่น|จักรยาน|bike|cycl/i, onsen: /ออนเซ็น|น้ำพุร้อน|onsen|hot spring|温泉|bathhouse/i,
  beach: /ทะเล|ชายหาด|หาด|beach|ว่ายน้ำ|swim/i, show: /โชว์|การแสดง|คอนเสิร์ต|show|concert|theat|acrobat|opera/i, cooking: /เรียนทำ|เวิร์กช็อป|workshop|cooking class|class/i,
  sunrise: /พระอาทิตย์ขึ้น|sunrise/i, sunset: /พระอาทิตย์ตก|sunset|ยามเย็น/i, museum: /พิพิธภัณฑ์|museum|gallery|美术馆|博物馆/i, kids: /เด็ก|kid|child|playground/i,
};
// [start minute, duration, hint for the AI, category]
const WANT_AT: Record<string, [number, number, string, string]> = {
  run: [375, 45, "06:15 before breakfast", "nature"], massage: [990, 90, "late afternoon", "other"], hike: [540, 150, "morning", "nature"], bike: [960, 90, "late afternoon", "other"],
  onsen: [1200, 90, "evening", "other"], beach: [900, 120, "afternoon", "nature"], show: [1170, 90, "evening, a show that really runs", "attraction"], cooking: [600, 150, "morning", "other"],
  sunrise: [345, 45, "at sunrise", "nature"], sunset: [1035, 45, "at sunset", "nature"], museum: [600, 120, "late morning", "attraction"], kids: [600, 120, "morning", "attraction"],
};
export async function planTrip(input: {
  destination: string; days: number; startDate: string | null;
  styles: string[]; pace: string; budget: string; mode: string; travelers: number; note: string | null;
  budgetTHB?: number | null; companions?: string; meals?: string[]; food?: string[]; must?: string | null;
  wants?: string[]; arrive_time?: string | null; depart_time?: string | null;
  /** local sunrise / sunset (HH:MM) at the destination on the first day */
  sun?: { rise: string; set: string } | null;
  /** after this (epoch ms) skip the optional repair calls so the whole job finishes in time */
  deadline?: number;
  existing: { name: string; day: number | null; category: string; time?: string | null }[];
  /** re-plan just one day of a longer trip */
  single?: { day: number; total: number; avoid: string[]; hotel?: string | null };
  /** long trips: plan days from..to (0-based) of the whole trip, following the outline written first */
  range?: { from: number; to: number; total: number; brief: { day: number; base: string; area: string; theme: string; hotel: string | null }[]; avoid: string[] };
}, meter?: Meter): Promise<TripPlan> {
  const one = input.single;
  const rg = one ? undefined : input.range;
  const hasArrival = !one && (!rg || rg.from === 0), hasDeparture = !one && (!rg || rg.to === rg.total - 1);
  const noSpicy = (input.food ?? []).includes("mild") || NO_SPICY.test(input.note ?? "");
  const dayKind = one ? (one.day === 0 ? "the ARRIVAL day (starts in the afternoon, lighter)" : one.day === one.total - 1 ? "the DEPARTURE day (ends early, finish near the airport/station)" : "a FULL day (morning to night)") : "";
  const perDay = input.pace === "relaxed" ? "3-4" : input.pace === "packed" ? "6-7" : "4-5";
  const modeTh = { transit: "เดิน + รถไฟฟ้า/รถเมล์", taxi: "แท็กซี่/Grab", drive: "ขับรถเอง/รถเช่า", walk: "เดินเป็นหลัก" }[input.mode] ?? "แท็กซี่/Grab";
  const plan = await gen<TripPlan>({
    model: MODEL,
    instructions:
      "You are an expert Thai travel planner. Build a realistic, geographically efficient itinerary for Thai travellers. " +
      "Rules: cluster each day's stops by area to minimise travel; order stops in visiting order; respect typical opening hours; " +
      "breakfast only at places that really serve breakfast and are open then (no bubble-tea, bars or dinner-only restaurants); every meal is a specific named restaurant, never a placeholder like 'breakfast near hotel'; " +
      "meals: include exactly the meals requested below as separate stops at real, well-known local restaurants (category food; café/dessert = cafe) inside the given time windows, close to the stops before and after; never two meals within 2.5 hours; " +
      "theme parks / amusement parks (Disney, Universal, Lotte World…): give them their own day, arrive at opening, duration 360-540 min, eat inside or right next to the park, nothing else that day except breakfast/dinner nearby; zoos take 3-5 h and aquariums 2-3 h — they share the day with nearby sights; " +
      "a good tour leader: each day has one area and a natural flow (morning sights before the heat/crowds, sunset viewpoint at sunset, markets in the evening), no back-and-forth across the city, last day ends near the airport/station; " +
      "stops must be in chronological order; start_time of each stop >= previous start_time + previous duration_min + realistic travel time; realistic durations (meal 45-90 min, café 45-60, big sight 90-180, viewpoint 30-60); " +
      "arrival day (day 0): the FIRST stop is the arrival airport or station (category transport, real name, 45-60 min for immigration/bags), then an easy afternoon/evening near the hotel; " +
      "departure day (last day): only places close to the hotel or on the way, and the LAST stop is the departure airport or station (category transport) — never a day trip out of town; " +
      "never add stops for transfers, check-in, check-out or resting (the hotel belongs in stays only); stop names are the place's own name with no activity label in front; " +
      "ONE hotel for the whole trip, central to the plan, unless the trip really moves between cities more than 60 km apart; " +
      "requested activities (running, massage, hiking…) are real stops at a specific named venue at the natural time of day (a run = a park or riverside path at 06:00-07:30 before breakfast; massage = late afternoon or after dinner); " +
      "include every place the group already saved, on a sensible day; never invent places — only real, currently operating ones; " +
      "give best-guess coordinates for everything; all user-facing text in natural Thai.",
    prompt:
      `Destination: ${input.destination}\n` +
      (one ? `Plan ONLY ONE DAY: day ${one.day} (0-based) of a ${one.total}-day trip${input.startDate ? `, date ${input.startDate}` : ""}. It is ${dayKind}. Return exactly one entry in days with day = ${one.day} and stays = [].\n` +
        (one.hotel ? `Staying at: ${one.hotel} — start and end the day near it\n` : "") +
        (one.avoid.length ? `Other days already visit (do NOT repeat): ${one.avoid.slice(0, 60).join("; ")}\n` : "")
        : rg ? `This is part of a ${rg.total}-day trip. Plan ONLY days ${rg.from}-${rg.to} (0-based)${input.startDate ? `; day ${rg.from} is ${input.startDate}` : ""}. Return exactly these days with these day numbers, and stays = [].\n` +
          `Follow this outline (base city, area, theme, hotel) — every stop of a day stays in or near its area:\n${rg.brief.map((b) => `- day ${b.day}: ${b.base} · ${b.area} · ${b.theme}${b.hotel ? ` · hotel ${b.hotel}` : ""}`).join("\n")}\n` +
          (rg.from > 0 ? `Day ${rg.from} is a normal full day (the group is already there); a day that starts in a new base city begins with the transfer (train/bus/flight as a transport stop) in the morning.\n` : "") +
          (rg.avoid.length ? `Other days of the trip already visit (do NOT repeat): ${rg.avoid.slice(0, 80).join("; ")}\n` : "")
        : `Days: ${input.days}${input.startDate ? ` starting ${input.startDate}` : ""}\n`) +
      `Travellers: ${input.travelers}\nStyle: ${input.styles.join(", ") || "balanced"}\nStops per day (excluding hotel): ${perDay}\n` +
      `Travelling as: ${{ friends: "a group of friends — fun, food-heavy, lively spots", date: "a couple on a DATE — romantic, scenic, sunset spots, cosy/nice restaurants for dinner, photo spots, unhurried, nothing rowdy", family: "a family — easy walking, kid/elderly friendly, rest breaks, early dinners", solo: "solo — flexible, safe areas, counter seating ok" }[input.companions ?? "friends"] ?? "friends"}\n` +
      `Meals to schedule each full day: ${(input.meals?.length ? input.meals : ["breakfast", "lunch", "dinner"]).map((m) => ({ breakfast: "breakfast 07:30-09:00 (near the hotel)", lunch: "lunch 11:30-13:30", dinner: "dinner 18:00-20:00", snack: "afternoon café/dessert 14:30-16:30", late: "late-night food after 21:00" }[m])).filter(Boolean).join("; ")} (arrival day and departure day: only the meals that fit)\n` +
      (input.food?.length ? `Food focus: ${input.food.map((f) => ({ local: "signature local dishes at places locals rate", street: "street food / night-market stalls", famous: "famous or Michelin/Bib Gourmand restaurants", seafood: "seafood", thai: "at least one Thai restaurant during the trip", mild: "NOT spicy — pick places with mild options", halal: "HALAL only", veg: "vegetarian-friendly only" }[f])).filter(Boolean).join("; ")}\n` : "") +
      (input.wants?.length ? `Activities the group asked for (each at least once, say in why that it was requested): ${input.wants.map((w) => WANT_EN[w]).filter(Boolean).join("; ")}\n` : "") +
      (!hasArrival && !hasDeparture ? "" : `Arrival: ${!hasArrival ? "not in these days" : input.arrive_time ? `lands/arrives at ${input.arrive_time} on day 0` : "around early afternoon on day 0 (time unknown)"}. Departure: ${!hasDeparture ? "not in these days — no airport at the end" : input.depart_time ? `flight/train leaves at ${input.depart_time} on the last day — be at the airport/station 2.5 hours before` : "last day, time unknown — finish sightseeing by 16:00 then go to the airport/station"}.\n`) +
      (input.must ? `MUST include these (place them on the most sensible day, keep the user's wording in why): ${input.must}\n` : "") +
      (input.budgetTHB ? `Hotel: at most about ${Math.max(600, Math.round((input.budgetTHB * 0.35 * Math.min(2, input.travelers)) / Math.max(1, (one ? one.total : rg ? rg.total : input.days) - 1) / 100) * 100)} THB per room per night (so the whole trip fits the cap) — pick a well-located 3-4 star or boutique hotel, not a luxury one\n` : "") +
      `Budget level: ${input.budget}${input.budgetTHB ? ` — HARD CAP about ${Math.round(input.budgetTHB)} THB per person for the whole trip including hotel and flights; pick hotels, food and paid sights that fit` : ""}\nGetting around: ${modeTh}\n` +
      (input.note ? `Group note — treat every restriction in it as a HARD rule (allergies, "no spicy", mobility, dislikes): ${input.note}\n` : "") +
      (noSpicy ? "Someone in the group does NOT eat spicy food: no Sichuan, Hunan, Chongqing, hot pot, mala or Yunnan-spicy restaurants at all; pick mild cuisines.\n" : "") +
      (input.sun ? `Daylight on these dates: sunrise ${input.sun.rise}, sunset ${input.sun.set}. A sunset stop starts ~40 min before sunset, a sunrise stop ~25 min before sunrise; outdoor photo spots go in daylight.\n` : "") +
      "Geography: each day covers ONE district or two adjacent ones, visited in a line (no back-and-forth across town); a district appears on one day only; breakfast is within walking distance of the hotel or the first stop; each meal is next to the stop before it.\n" +
      "Opening hours: temples, museums, gardens, palaces and historic houses close around 16:30-17:00 — never schedule them after 16:00; evenings are for streets, riversides, night views, shows, markets and bars.\n" +
      "Variety: at most ONE paid observation deck / tower view in the whole trip. A theme-park day is the whole day until the closing show, with lunch and dinner inside the park or its own dining street, and nothing else that day.\n" +
      (input.existing.length ? (one ? `Keep these on this day (the group chose them): ${input.existing.map((e) => `${e.name}${e.time ? ` @${String(e.time).slice(0, 5)}` : ""}`).join("; ")}\n` : `Already saved by the group (must include): ${input.existing.map((e) => `${e.name}${e.day != null ? ` [day ${e.day}]` : ""}${e.time ? ` @${String(e.time).slice(0, 5)}` : ""}`).join("; ")}\n`) : "") +
      (input.existing.some((e) => e.time) ? "Items marked @HH:MM are booked at that exact time: put them at that time and plan the rest of the day around them.\n" : ""),
    output: Output.object({ schema: planSchema }),
    maxOutputTokens: 12000,
  }, meter);
  // tour-leader QA: drop pseudo stops (check-in, hotel as a stop), then make sure every requested meal is a real restaurant
  const nDays = one ? one.total : rg ? rg.total : input.days;
  const rawDays = one ? plan.days.slice(0, 1).map((d) => ({ ...d, day: one.day }))
    // a model that numbered the chunk 0..n instead of from..to: shift it back
    : rg ? plan.days.map((d, i) => ({ ...d, day: d.day >= rg.from && d.day <= rg.to ? d.day : rg.from + i })) : plan.days;
  if (one || rg) plan.stays = [];
  let days = rawDays.filter((d) => d.day >= 0 && d.day < nDays && (!rg || (d.day >= rg.from && d.day <= rg.to)))
    .map((d) => ({ ...d, stops: fixSchedule(d.stops.map(cleanName).filter((x) => x.category !== "stay" && !PSEUDO.test(`${x.name} ${x.name_local ?? ""}`)).slice(0, 10)) }));
  const arr = input.arrive_time ? toMin(input.arrive_time) : null;
  if (arr != null && hasArrival) days = days.map((d) => (d.day !== 0 ? d : { ...d, stops: d.stops.filter((x) => x.category === "transport" || (toMin(x.start_time) ?? 1e9) >= arr + 30) }));
  const late = () => input.deadline != null && Date.now() > input.deadline;
  // ---- hard rules the model keeps breaking (each one came from a real bad plan) ----
  days = days.map((d) => {
    let stops = d.stops;
    const eatS = (x: Stop) => x.category === "food" || x.category === "cafe";
    // 1) "no spicy" means no Sichuan lunch
    if (noSpicy) stops = stops.filter((x) => !(eatS(x) && SPICY.test(`${x.name} ${x.name_local ?? ""} ${String(x.why ?? "").replace(/ไม่เผ็ด|ไม่ค่อยเผ็ด|not spicy|non.?spicy|mild/gi, "")}`)));
    // 2) temples / museums / gardens are closed in the evening
    stops = stops.filter((x) => !(DAYTIME_ONLY.test(`${x.name} ${x.name_local ?? ""}`) && !eatS(x) && x.category !== "shopping" && (toMin(x.start_time) ?? 0) >= 17 * 60 + 30));
    // last day: nothing far out of town before the flight (Zhujiajiao at 14:30 then the airport)
    if (hasDeparture && nDays > 1 && d.day === nDays - 1) {
      const pts = days.flatMap((x) => x.stops).filter((x) => x.lat != null && x.lng != null);
      const mid = pts.length ? { lat: [...pts].sort((a, b) => a.lat! - b.lat!)[Math.floor(pts.length / 2)].lat!, lng: [...pts].sort((a, b) => a.lng! - b.lng!)[Math.floor(pts.length / 2)].lng! } : null;
      if (mid) stops = stops.filter((x) => x.category === "transport" || x.lat == null || (dist(mid, x) ?? 0) < 25);
    }
    // 3) a theme-park day is the park, its meals, and nothing else
    // zoos / aquariums are half a day, not a whole one (Taronga for 9 h with nothing else was a real plan)
    const big = stops.find((x) => BIG.test(x.name) && !/zoo|aquarium|sea ?life|สวนสัตว์|อควาเรียม|ซาฟารี/i.test(`${x.name} ${x.name_local ?? ""}`) && (x.category === "attraction" || x.category === "nature"));
    if (big && d.day > 0 && (d.day < nDays - 1 || one)) {
      const b0 = toMin(big.start_time) ?? 9 * 60;
      stops = stops.filter((x) => x === big || (toMin(x.start_time) ?? 0) < b0 || eatS(x) || (dist(big, x) ?? 99) < 3)
        .map((x) => (x === big ? { ...x, start_time: toHHMM(Math.min(b0, 9 * 60 + 30)), duration_min: Math.max(Number(x.duration_min) || 0, 570) } : x));
    }
    return { ...d, stops };
  });
  // 4) one observation deck per trip is plenty
  let decks = 0;
  days = days.map((d) => ({ ...d, stops: d.stops.filter((x) => !(x.category === "attraction" && DECK.test(`${x.name} ${x.name_local ?? ""}`) && decks++ > 0)) }));
  const meals = input.meals?.length ? input.meals : ["breakfast", "lunch", "dinner"];
  // activities the group asked for that the plan forgot → one repair call, each on its own full day at the natural hour
  const missing = (input.wants ?? []).filter((w) => WANT_RE[w] && !days.some((d) => d.stops.some((x) => WANT_RE[w].test(`${x.name} ${x.name_local ?? ""} ${x.why}`))));
  if (missing.length && !rg && !(input.deadline != null && Date.now() > input.deadline + 30_000)) {
    const pool = days.filter((d) => (nDays <= 2 || (d.day > 0 && d.day < nDays - 1)) && !d.stops.some((x) => BIG.test(x.name)));
    const asks = missing.slice(0, 4).map((w, i) => ({ w, d: (pool.length ? pool : days)[i % Math.max(1, (pool.length ? pool : days).length)] })).filter((a) => a.d);
    try {
      const got = await fillMeals({ destination: input.destination, companions: input.companions }, asks.map((a) => {
        const near = a.d.stops.find((x) => x.lat != null);
        return { day: a.d.day, meal: `${WANT_EN[a.w]} (${WANT_AT[a.w]?.[2] ?? ""})`, around: near ? `${near.name} (${near.lat},${near.lng})` : "the hotel" };
      }), meter, true);
      days = days.map((d) => {
        const mine = asks.filter((a) => a.d.day === d.day);
        if (!mine.length) return d;
        const extra = mine.map((a, i) => {
          const g = got.filter((x) => x.day === d.day)[i] ?? null;
          if (!g) return null;
          const [at, dur, , cat] = WANT_AT[a.w] ?? [15 * 60, 60, "", "other"];
          const { day: _d, meal: _m, ...st } = g;
          // tag it with the activity so the run/sunrise/sunset rules below (and the user) can recognise it
          return { ...cleanName(st), start_time: toHHMM(at), duration_min: dur, category: cat as Stop["category"], why: `${WANT_TH[a.w] ?? "กิจกรรมที่ขอไว้"} · ${st.why || "ตามที่ขอไว้"}` };
        }).filter(Boolean) as Stop[];
        // a 06:15 run must come before breakfast, not push it: sort by time and let later stops keep their own times
        return { ...d, stops: fixSchedule([...extra, ...d.stops]) };
      });
    } catch { /* keep the plan */ }
  }
  // up to two repair rounds: the free models often answer only part of a long list
  for (let round = 0, gaps = mealGaps(days, meals, nDays); round < 2 && gaps.length && !late(); round++, gaps = mealGaps(days, meals, nDays)) {
    try {
      const add = await fillMeals({ destination: input.destination, companions: input.companions, food: noSpicy ? [...(input.food ?? []), "mild"] : input.food }, gaps.slice(0, 16), meter);
      const key = (m: string) => Object.keys(MEAL_WIN).find((k) => m.toLowerCase().includes(k)) ?? (/เช้า/.test(m) ? "breakfast" : /กลางวัน|เที่ยง/.test(m) ? "lunch" : /เย็น|ค่ำ/.test(m) ? "dinner" : /ดึก/.test(m) ? "late" : /คาเฟ่|ขนม|ของหวาน/.test(m) ? "snack" : m);
      days = days.map((d) => {
        const want = gaps.filter((g) => g.day === d.day);
        const mine = add.filter((a) => a.day === d.day && want.some((g) => g.meal === key(a.meal)));
        if (!mine.length) return d;
        const fixed = new Set(mine.map((a) => key(a.meal)));
        const replaced = new Set(want.filter((g) => g.replace && fixed.has(g.meal)).map((g) => g.replace));
        // drop the placeholders / detours these replace
        const kept = d.stops.filter((x) => !replaced.has(x.name) && !(GENERIC.test(x.name) && [...fixed].some((m) => { const [a, b] = MEAL_WIN[m]; const t = toMin(x.start_time) ?? -1; return t >= a - 30 && t <= b; })));
        const extra = mine.map(({ day: _d, meal: m, ...st }) => {
          const [a, b] = MEAL_WIN[key(m)] ?? [0, 1440];
          const t = toMin(st.start_time);
          return { ...st, start_time: t != null && t >= a && t <= b ? st.start_time : toHHMM(a + 30), category: st.category === "cafe" ? "cafe" as const : "food" as const };
        });
        return { ...d, stops: fixSchedule([...kept, ...extra]) };
      });
    } catch { /* keep the plan; meals stay as the AI gave them */ }
  }
  // a morning run happens before breakfast, not between breakfast and sightseeing
  days = days.map((d) => {
    const run = d.stops.find((x) => WANT_RE.run.test(`${x.name} ${x.why}`) && x.category !== "food" && x.category !== "cafe" && (toMin(x.start_time) ?? 0) >= 7 * 60 + 30 && (toMin(x.start_time) ?? 0) <= 11 * 60);
    if (!run || d.day === 0) return d;
    return { ...d, stops: fixSchedule([{ ...run, start_time: "06:15", duration_min: Math.min(60, run.duration_min || 45) }, ...d.stops.filter((x) => x !== run)]) };
  });
  // sunrise / sunset stops happen at sunrise / sunset
  if (input.sun) {
    const rise = toMin(input.sun.rise), set = toMin(input.sun.set);
    days = days.map((d) => {
      const up = d.stops.find((x) => WANT_RE.sunrise.test(`${x.name} ${x.why}`) && x.category !== "food");
      const down = d.stops.find((x) => WANT_RE.sunset.test(`${x.name} ${x.why}`) && x !== up);
      if (!up && !down) return d;
      let stops = d.stops;
      if (up && rise != null && d.day > 0) stops = [{ ...up, start_time: toHHMM(Math.max(4 * 60 + 30, rise - 25)), duration_min: 50 }, ...stops.filter((x) => x !== up)];
      if (down && set != null) {
        const at = set - 40;
        // whatever overlaps the golden hour moves out of the way instead of pushing the sunset into the dark
        stops = stops.filter((x) => x === down || !((toMin(x.start_time) ?? 0) < at + 60 && (toMin(x.start_time) ?? 0) + (Number(x.duration_min) || 60) > at) || x.category === "transport" || BIG.test(x.name))
          .map((x) => (x === down ? { ...x, start_time: toHHMM(at), duration_min: Math.max(60, Math.min(90, Number(x.duration_min) || 60)) } : x));
      }
      return { ...d, stops: fixSchedule(stops) };
    });
  }
  // departure day ends at the airport/station you arrived at when the plan forgot to say so
  if (!one && !rg && nDays > 1) {
    const hub = days.find((d) => d.day === 0)?.stops.find((x) => x.category === "transport");
    const last = days.find((d) => d.day === nDays - 1);
    if (hub && last && !last.stops.some((x) => x.category === "transport")) {
      const dep = input.depart_time ? toMin(input.depart_time) : null;
      const lastEnd = Math.max(0, ...last.stops.map((x) => (toMin(x.start_time) ?? 0) + (x.duration_min || 60)));
      const at = dep != null ? Math.max(6 * 60, dep - 150) : Math.min(21 * 60, Math.max(lastEnd + 45, 15 * 60));
      last.stops = [...last.stops.filter((x) => (toMin(x.start_time) ?? 0) < at), { ...hub, start_time: toHHMM(at), duration_min: dep != null ? 150 : 120, why: dep != null ? `ถึงก่อนเวลาออกเดินทาง ${input.depart_time} ราว 2 ชม.ครึ่ง เผื่อเช็กอินและตรวจคนเข้าเมือง` : "เดินทางกลับ ควรถึงก่อนเวลาออกเดินทาง 2-3 ชม." }];
    }
  }
  // placeholders that still have no real replacement stay only if they're pinned (e.g. hotel breakfast)
  days = days.map((d) => ({ ...d, stops: d.stops.filter((x) => !GENERIC.test(x.name) || x.lat != null).slice(0, 10) }));
  // the same restaurant / sight twice in one trip is a planning bug — keep the first (airports may repeat)
  const seen = new Set<string>();
  const key2 = (x: Stop) => (x.name_local || x.name).toLowerCase().replace(/[\s()（）\-–·.,]/g, "").replace(/(branch|店|สาขา).*$/, "");
  days = days.map((d) => ({ ...d, stops: d.stops.filter((x) => { if (x.category === "transport") return true; const k = key2(x); if (seen.has(k)) return false; seen.add(k); return true; }) }));
  return {
    ...plan,
    days,
    stays: plan.stays.filter((st, i, all) => i === 0 || all.slice(0, i).every((p) => { const d = dist(p, st); return d != null && d > 60; })).slice(0, 3)
      .map((st, i, kept) => (kept.length === 1 ? { ...st, check_in_day: 0, nights: Math.max(1, nDays - 1) } : st)),
    tips: plan.tips.slice(0, 6),
  };
}

const outlineSchema = planSchema.omit({ days: true }).extend({
  stays: z.array(z.object({
    name: z.string(), name_local: z.string().nullable(), area: z.string().describe("Neighbourhood, Thai"),
    lat: z.number().nullable(), lng: z.number().nullable(),
    check_in_day: z.number().describe("0-based day index"), nights: z.number(),
    price: z.string().describe("Thai, price per night range in THB"), why: z.string().describe("Thai, one line"),
  })).describe("one hotel per base city/region, in order, covering every night; a base is kept at least 3 nights unless the route really needs a stopover"),
  days: z.array(z.object({
    day: z.number().describe("0-based"),
    base: z.string().describe("city / region the group sleeps in that night, English"),
    area: z.string().describe("the district or day-trip destination for that day, English, specific"),
    theme: z.string().describe("Thai, short title for the day"),
  })).describe("every day of the trip, in order"),
  assign: z.array(z.object({ name: z.string(), day: z.number() })).describe("each place the group already saved → the 0-based day it fits best"),
});
export type TripOutline = z.infer<typeof outlineSchema>;

/** Long trips (a week to a couple of months): first the shape — bases, a hotel per base, one area per day, saved places assigned —
 *  then the days are planned a few at a time (planTrip with range), each in its own request so nothing times out. */
export async function planOutline(input: {
  destination: string; days: number; startDate: string | null; styles: string[]; pace: string; budget: string; mode: string;
  travelers: number; note: string | null; budgetTHB?: number | null; companions?: string; food?: string[]; must?: string | null;
  wants?: string[]; arrive_time?: string | null; depart_time?: string | null; existing: { name: string; day: number | null }[];
}, meter?: Meter): Promise<TripOutline> {
  const out = await gen<TripOutline>({
    model: MODEL,
    instructions:
      "You are an expert Thai travel planner designing the SHAPE of a long trip for Thai travellers (the daily stops are planned later). " +
      "Pick a realistic route of bases (cities/regions) for the whole trip — no zig-zag, sensible transfers, at least 3 nights per base unless a stopover really helps, " +
      "rest/light days every 5-7 days on long trips, weather and season aware for these dates. For each day give the base, ONE specific area or day-trip destination, and a short Thai theme; " +
      "no area repeats unless it is the base's centre; a transfer day between bases is light. Day 0 starts on arrival, the last day ends at the departure airport/station. " +
      "One hotel per base (well located, real, operating), covering every night. Assign every saved place to the day whose area it belongs to. All user-facing text in natural Thai.",
    prompt:
      `Destination: ${input.destination}\nDays: ${input.days}${input.startDate ? ` starting ${input.startDate}` : ""}\nTravellers: ${input.travelers} (${input.companions ?? "friends"})\n` +
      `Style: ${input.styles.join(", ") || "balanced"} · pace ${input.pace} · budget ${input.budget}${input.budgetTHB ? ` (about ${Math.round(input.budgetTHB)} THB per person in total)` : ""} · getting around: ${input.mode}\n` +
      (input.food?.length ? `Food: ${input.food.join(", ")}\n` : "") +
      (input.wants?.length ? `Activities they want during the trip: ${input.wants.map((w) => WANT_EN[w]).filter(Boolean).join("; ")} — give them suitable days/areas\n` : "") +
      `Arrival: ${input.arrive_time ?? "unknown time"} on day 0. Departure: ${input.depart_time ?? "unknown time"} on day ${input.days - 1}.\n` +
      (input.must ? `MUST include: ${input.must}\n` : "") + (input.note ? `Group note (hard rules): ${input.note}\n` : "") +
      (input.existing.length ? `Saved places to assign: ${input.existing.map((e) => `${e.name}${e.day != null ? ` [day ${e.day}]` : ""}`).join("; ")}\n` : ""),
    output: Output.object({ schema: outlineSchema }),
    maxOutputTokens: Math.min(9000, 2500 + input.days * 90),
  }, meter);
  // every day present, in range, in order
  const byDay = new Map(out.days.filter((d) => d.day >= 0 && d.day < input.days).map((d) => [Math.round(d.day), d]));
  let prev = out.days[0] ?? { day: 0, base: input.destination, area: input.destination, theme: "" };
  out.days = Array.from({ length: input.days }, (_, i) => { const d = byDay.get(i) ?? { ...prev, day: i, theme: prev.theme }; prev = d; return { ...d, day: i }; });
  out.stays = out.stays.filter((s) => s.check_in_day >= 0 && s.check_in_day < input.days).sort((a, b) => a.check_in_day - b.check_in_day).slice(0, 12);
  return out;
}

const translateSchema = z.object({ queries: z.array(z.string()).describe("1-3 search strings: official English name, local-language name, romanized") });
/** Thai query for a place abroad → names a map search engine will match ("วัดหลิงอิน" → "Lingyin Temple", "灵隐寺"). */
export async function translatePlaceQuery(q: string, destination: string | null, meter?: Meter) {
  const out = await gen<z.infer<typeof translateSchema>>({
    model: MODEL,
    instructions: "Convert the user's place search (often Thai transliteration) into the names used on OpenStreetMap for that place. Return only names; if it is a generic word (e.g. 'คาเฟ่'), translate it to English.",
    prompt: `Query: ${q}\nTrip destination: ${destination ?? "unknown"}`,
    output: Output.object({ schema: translateSchema }),
    maxOutputTokens: 200,
  }, meter);
  return out.queries.map((s) => s.trim()).filter(Boolean).slice(0, 3);
}

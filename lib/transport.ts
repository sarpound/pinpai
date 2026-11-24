// How to actually get from one stop to the next, the way a local guide would explain it:
// which options make sense for the distance, roughly how long and how much, which app to open,
// how to pay at the gate, and what to show the driver. Free and deterministic (no transit API):
// exact lines and platforms come from the map app the link opens.
import { legMinutes, type Calib } from "./retime";
import { inMainlandChina, inHongKong, inMacau, localName, routeUrl, type LL } from "./maplinks";

type Fare = { cur: string; base: number; perKm: number; baseKm: number };
type Local = {
  key: string;
  metro: string | null;     // what the train/metro is called + how to pay (null: no useful rail for city hops)
  bus: string | null;
  taxi: string;             // which app to call a car with + tips
  local?: string;           // the local extra: songthaew, tuk-tuk, motorbike taxi, ferry…
  fare?: Fare;              // metered taxi / ride-hail, rough
  transitFare?: string;
  showDriver?: boolean;     // drivers mostly read only the local script
  carFirst?: boolean;       // where locals and visitors mostly ride cars (Bali, Phuket…)
  mapApp: string;
};

// rough per-country (and a few city) guides; the first matching box wins
const LOCAL: (Local & { box: (lat: number, lng: number) => boolean })[] = [
  { key: "cn", box: (a, o) => inMainlandChina(a, o), mapApp: "Amap (高德)", showDriver: true,
    metro: "รถไฟใต้ดิน (地铁 dìtiě) · จ่ายด้วย Alipay: กด 出行 → 乘车码 แล้วสแกนที่ประตู (ผูกบัตรต่างชาติได้) · ต้องสแกนกระเป๋าตอนเข้าสถานี",
    bus: "รถเมล์ (公交 gōngjiāo) · สแกน 乘车码 ใน Alipay ตอนขึ้นประตูหน้า",
    taxi: "เรียก DiDi (滴滴) ใน Alipay → 出行 → 打车 (มีเมนูอังกฤษ) หรือโบกแท็กซี่ได้ · ยื่นชื่อจีนด้านล่างให้คนขับดู",
    local: "เช่าจักรยาน/สกู๊ตเตอร์ Hellobike / Meituan ใน Alipay สแกนปลดล็อกได้ (ริมทะเลสาบ/ย่านเมืองเก่าสะดวกมาก)",
    fare: { cur: "¥", base: 11, perKm: 2.5, baseKm: 3 }, transitFare: "¥2–6" },
  { key: "hk", box: (a, o) => inHongKong(a, o), mapApp: "Google Maps / Citymapper",
    metro: "MTR · แตะ Octopus หรือบัตรเครดิต contactless ที่ประตู", bus: "รถเมล์ 2 ชั้น · แตะ Octopus ตอนขึ้น (ไม่ทอนเงินสด)",
    taxi: "แท็กซี่แดง/แอป HKTaxi หรือ Uber · บางคันรับแต่เงินสด", local: "เรือ Star Ferry ข้ามอ่าว (แตะ Octopus)",
    fare: { cur: "HK$", base: 29, perKm: 10, baseKm: 2 }, transitFare: "HK$5–15" },
  { key: "mo", box: (a, o) => inMacau(a, o), mapApp: "Google Maps",
    metro: null, bus: "รถเมล์ · จ่าย MOP6 เงินสด (ไม่ทอน) หรือบัตร Macau Pass", taxi: "แท็กซี่ / แอป Macau Taxi · รถชัตเทิลฟรีของคาสิโนวิ่งหลายเส้น",
    fare: { cur: "MOP", base: 21, perKm: 8, baseKm: 1.6 } },
  { key: "tw", box: (a, o) => o > 119.3 && o < 122.2 && a > 21.7 && a < 25.4, mapApp: "Google Maps",
    metro: "MRT · แตะบัตร EasyCard (悠遊卡) ที่ประตู ห้ามกิน-ดื่มในสถานี", bus: "รถเมล์ · แตะ EasyCard ตอนขึ้น (บางสายแตะตอนลงด้วย)",
    taxi: "แท็กซี่สีเหลือง/แอป 55688 หรือ Uber", local: "เช่าจักรยาน YouBike แตะ EasyCard",
    fare: { cur: "NT$", base: 85, perKm: 25, baseKm: 1.25 }, transitFare: "NT$20–40" },
  { key: "jp", box: (a, o) => a > 24 && a < 46 && o > 122.9 && o < 146 && !(a < 38.7 && o < 129.6), mapApp: "Google Maps",
    metro: "รถไฟ/รถไฟใต้ดิน · แตะ Suica/PASMO/ICOCA (หรือ Suica ใน Apple Wallet) ที่ประตู ใช้ได้ทุกบริษัท",
    bus: "รถเมล์ · ขึ้นประตูกลาง แตะบัตร IC ตอนขึ้นและตอนลง (เกียวโตส่วนใหญ่ขึ้นหลังจ่ายหน้า)",
    taxi: "แอป GO หรือ Uber · โบกได้ ประตูหลังเปิด-ปิดเอง ไม่ต้องให้ทิป",
    fare: { cur: "¥", base: 500, perKm: 400, baseKm: 1.1 }, transitFare: "¥180–400" },
  { key: "kr", box: (a, o) => a > 33 && a < 39 && o > 124.5 && o < 130, mapApp: "Naver Map / KakaoMap", showDriver: true,
    metro: "รถไฟใต้ดิน · แตะ T-money/WOWPASS ที่ประตู (Google Maps นำทางในเกาหลีไม่ครบ ใช้ Naver Map/KakaoMap)",
    bus: "รถเมล์ · แตะ T-money ตอนขึ้นและตอนลง (เปลี่ยนสายฟรีใน 30 นาที)",
    taxi: "แอป Kakao T (ผูกบัตรต่างชาติได้) หรือ Uber · ยื่นชื่อเกาหลีด้านล่างให้คนขับดู",
    fare: { cur: "₩", base: 4800, perKm: 1100, baseKm: 1.6 }, transitFare: "₩1,500–2,000" },
  { key: "sg", box: (a, o) => a > 1.15 && a < 1.5 && o > 103.6 && o < 104.1, mapApp: "Google Maps",
    metro: "MRT · แตะบัตรเครดิต contactless ที่ประตูได้เลย", bus: "รถเมล์ · แตะบัตรเครดิต contactless ตอนขึ้นและตอนลง",
    taxi: "Grab / Gojek / TADA", fare: { cur: "S$", base: 4.4, perKm: 0.8, baseKm: 1 }, transitFare: "S$1–2.5" },
  { key: "th-bkk", box: (a, o) => a > 13.5 && a < 14.1 && o > 100.3 && o < 100.95, mapApp: "Google Maps",
    metro: "BTS/MRT · MRT แตะบัตรเครดิต contactless ได้ BTS ซื้อตั๋ว/บัตร Rabbit · เรือด่วนเจ้าพระยาไปฝั่งเกาะรัตนโกสินทร์",
    bus: null, taxi: "Grab / Bolt (ราคาตายตัวก่อนขึ้น) · แท็กซี่ให้กดมิเตอร์ ช่วงรถติดรถไฟฟ้าเร็วกว่า",
    local: "วินมอเตอร์ไซค์ (เสื้อกั๊กส้ม) ระยะสั้นเลี่ยงรถติด · ตุ๊กตุ๊กต่อราคาก่อนขึ้น",
    fare: { cur: "฿", base: 35, perKm: 7, baseKm: 1 }, transitFare: "฿17–60" },
  { key: "th", box: (a, o) => a > 5.5 && a < 20.5 && o > 97.3 && o < 105.7, mapApp: "Google Maps", carFirst: true,
    metro: null, bus: null, taxi: "Grab / Bolt (ภูเก็ต/เชียงใหม่/พัทยามีครบ) · แท็กซี่ท่องเที่ยวตกลงราคาก่อน",
    local: "รถสองแถว (เชียงใหม่สีแดง) โบกแล้วบอกจุดหมาย ตกลงราคาก่อนขึ้น · เช่ามอเตอร์ไซค์ต้องมีใบขับขี่สากล",
    fare: { cur: "฿", base: 40, perKm: 12, baseKm: 1 } },
  { key: "my", box: (a, o) => a > 0.8 && a < 7.5 && o > 99.5 && o < 119.5 && !(a < 1.5 && o > 103.6 && o < 104.1), mapApp: "Google Maps",
    metro: "LRT/MRT/Monorail (KL) · แตะบัตร Touch 'n Go หรือบัตรเครดิต contactless", bus: "รถเมล์ GO KL ฟรีในใจกลางเมือง",
    taxi: "Grab (ถูกและง่ายที่สุด)", fare: { cur: "RM", base: 5, perKm: 1.2, baseKm: 1 }, transitFare: "RM1.5–5" },
  { key: "vn", box: (a, o) => a > 8.3 && a < 23.5 && o > 102 && o < 110, mapApp: "Google Maps", carFirst: true,
    metro: null, bus: null, taxi: "Grab / Xanh SM (รถไฟฟ้า) / Be · แท็กซี่ Mai Linh/Vinasun กดมิเตอร์",
    local: "มอเตอร์ไซค์รับจ้างในแอป Grab/Be ถูกและเร็ว (ใส่หมวกที่คนขับให้) · ข้ามถนนเดินช้าๆ สม่ำเสมอ",
    fare: { cur: "₫", base: 12000, perKm: 16000, baseKm: 1 } },
  { key: "id", box: (a, o) => a > -11 && a < 6 && o > 95 && o < 141, mapApp: "Google Maps", carFirst: true,
    metro: null, bus: null, taxi: "Gojek / Grab · บาหลีบางเขต (อูบุด, ชางกู) ห้ามรถแอปรับ ต้องเดินออกจุดรับหรือใช้ Bluebird",
    local: "จ้างคนขับพร้อมรถทั้งวัน (~600–800k IDR) คุ้มสุดสำหรับเที่ยวหลายจุดในบาหลี · มอเตอร์ไซค์ในแอปฝ่ารถติด",
    fare: { cur: "Rp", base: 10000, perKm: 6500, baseKm: 1 } },
  { key: "ph", box: (a, o) => a > 4.5 && a < 21 && o > 116 && o < 127, mapApp: "Google Maps", carFirst: true,
    metro: "MRT/LRT (มะนิลา) · แตะบัตร Beep", bus: null, taxi: "Grab · แท็กซี่ให้กดมิเตอร์",
    local: "จี๊ปนีย์ จ่ายเหรียญส่งต่อไปข้างหน้า · มอเตอร์ไซค์ Angkas/JoyRide", fare: { cur: "₱", base: 45, perKm: 15, baseKm: 1 } },
  { key: "in", box: (a, o) => a > 6 && a < 36 && o > 68 && o < 97.5, mapApp: "Google Maps", carFirst: true,
    metro: "Metro (เดลี/มุมไบ/เบงกาลูรู) · ซื้อโทเคน/QR ตั๋วที่ตู้หรือแอป", bus: null,
    taxi: "Uber / Ola", local: "ออโต้ริกชอว์ในแอป Uber/Ola ราคาชัดเจนกว่าโบก", fare: { cur: "₹", base: 50, perKm: 18, baseKm: 1 } },
  { key: "ae", box: (a, o) => a > 22.5 && a < 26.5 && o > 51 && o < 56.5, mapApp: "Google Maps",
    metro: "Dubai Metro · บัตร Nol (มีตู้โดยสารผู้หญิง/Gold class แยก)", bus: null, taxi: "Careem / Uber / แท็กซี่ RTA (กดมิเตอร์)",
    fare: { cur: "AED", base: 12, perKm: 2.2, baseKm: 1 } },
  { key: "tr", box: (a, o) => a > 36 && a < 42.2 && o > 26 && o < 45, mapApp: "Google Maps",
    metro: "Metro/Tram/เรือข้ามฟาก (อิสตันบูล) · แตะ Istanbulkart", bus: "รถเมล์ · Istanbulkart", taxi: "BiTaksi / Uber (แท็กซี่เหลืองให้กดมิเตอร์)",
    fare: { cur: "₺", base: 60, perKm: 40, baseKm: 1 } },
  { key: "gb", box: (a, o) => a > 49.8 && a < 59 && o > -8.7 && o < 2, mapApp: "Google Maps / Citymapper",
    metro: "Tube/Overground · แตะบัตรเครดิต contactless (ระบบคิดเพดานรายวันให้เอง ใช้ใบเดิมทั้งทริป)", bus: "รถเมล์ · แตะ contactless (ไม่รับเงินสด)",
    taxi: "Uber / Bolt / black cab (โบกได้ กดมิเตอร์)", fare: { cur: "£", base: 4, perKm: 2.5, baseKm: 1 }, transitFare: "£1.75–3.5" },
  { key: "fr", box: (a, o) => a > 42.3 && a < 51.1 && o > -5 && o < 8.2, mapApp: "Google Maps / Citymapper",
    metro: "Métro/RER (ปารีส) · ใช้ Navigo Easy หรือตั๋วในแอป Île-de-France Mobilités (contactless ยังไม่ครบทุกสาย)", bus: "รถเมล์ · ตั๋วใบเดียวกับ Métro ต้องแตะตอนขึ้น",
    taxi: "Uber / Bolt / G7", fare: { cur: "€", base: 4.5, perKm: 1.6, baseKm: 1 }, transitFare: "€2.15–2.5" },
  { key: "eu", box: (a, o) => a > 35 && a < 71 && o > -11 && o < 40, mapApp: "Google Maps",
    metro: "รถไฟใต้ดิน/รถราง · หลายเมืองแตะ contactless ได้ หรือซื้อตั๋วในแอปของเมือง (เยอรมนี/อิตาลีต้องปั๊มตั๋วก่อนขึ้น ไม่งั้นโดนปรับ)",
    bus: "รถเมล์/รถราง · ตั๋วใช้ร่วมกับรถไฟใต้ดิน", taxi: "Uber / Bolt / FREENOW", fare: { cur: "€", base: 4, perKm: 2, baseKm: 1 } },
  { key: "au", box: (a, o) => a > -44 && a < -10 && o > 112 && o < 154, mapApp: "Google Maps",
    metro: "รถไฟ/รถราง/เฟอร์รี · ซิดนีย์แตะ contactless (Opal), เมลเบิร์นใช้ Myki (รถรางในเมืองฟรี)", bus: "รถเมล์ · ระบบบัตรเดียวกับรถไฟ",
    taxi: "Uber / DiDi / Ola", fare: { cur: "A$", base: 4.2, perKm: 2.3, baseKm: 1 } },
  { key: "us", box: () => true, mapApp: "Google Maps",
    metro: "รถไฟใต้ดิน/รถไฟ · แตะบัตรเครดิต contactless ได้ในหลายเมือง (นิวยอร์ก: OMNY)", bus: "รถเมล์ · แตะบัตร/contactless ตอนขึ้น",
    taxi: "Uber / Lyft · ทิปคนขับ 15–20%", fare: { cur: "$", base: 4, perKm: 2, baseKm: 1 } },
];

const localOf = (p: LL) => LOCAL.find((l) => l.box(p.lat, p.lng))!;

export type RideOption = { kind: "walk" | "transit" | "car"; min: number; title: string; how: string; cost: string | null; url: string };
export type RideGuide = { options: RideOption[]; driverText: string | null; mapApp: string };

/** the sensible ways from A to B, in the order a local would suggest them */
export function rideGuide(a: LL & { name?: string }, b: LL & { name?: string }, roadKm: number, carMin: number | null, calib?: Calib | null): RideGuide {
  const L = localOf(b);
  const out: RideOption[] = [];
  const walkMin = Math.max(2, Math.round((roadKm / 4.5) * 60));
  const fmt = (n: number) => (n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n * 10) / 10).toLocaleString("en-US");
  if (roadKm <= 2.5) out.push({ kind: "walk", min: walkMin, title: "เดิน", how: roadKm <= 1 ? "ใกล้ เดินสบาย" : "เดินได้ ถ้าอากาศดีและไม่รีบ", cost: null, url: routeUrl(a, b, "walk") });
  if (roadKm > 0.8 && (L.metro || L.bus)) {
    const t = legMinutes(roadKm, carMin, "transit", calib);
    out.push({ kind: "transit", min: t.kind === "walk" ? walkMin : t.min, title: L.metro ? "รถไฟฟ้า/รถไฟใต้ดิน" + (L.bus ? " หรือรถเมล์" : "") : "รถเมล์",
      how: [L.metro, L.bus, `สายที่ต้องขึ้น/เปลี่ยน ดูใน ${L.mapApp} (ปุ่มด้านขวา)`].filter(Boolean).join("\n"), cost: L.transitFare ?? null, url: routeUrl(a, b, "transit") });
  }
  if (roadKm > 0.8) {
    const c = legMinutes(roadKm, carMin, "taxi", calib);
    const fare = L.fare ? L.fare.base + Math.max(0, roadKm - L.fare.baseKm) * L.fare.perKm : null;
    out.push({ kind: "car", min: c.kind === "walk" ? walkMin : c.min, title: "เรียกรถ / แท็กซี่", how: [L.taxi, L.local].filter(Boolean).join("\n"),
      cost: fare != null ? `≈ ${L.fare!.cur}${fmt(fare * 0.9)}–${fmt(fare * 1.25)}` : null, url: routeUrl(a, b, "car") });
  } else if (L.local && roadKm > 0.5) out[0].how += `\n${L.local}`;
  // order: walk when it's short, then what locals use there (cars in Bali/Vietnam/most of Thailand, trains elsewhere)
  const rank = (o: RideOption) => (o.kind === "walk" ? (roadKm <= 1.2 ? 0 : 3) : o.kind === "transit" ? (L.carFirst ? 2 : 1) : (L.carFirst ? 1 : 2));
  // what to show the driver: the destination in the local script
  const driverText = L.showDriver && b.name && localName(b.name) !== b.name ? localName(b.name) : null;
  return { options: out.sort((x, y) => rank(x) - rank(y)), driverText, mapApp: L.mapApp };
}

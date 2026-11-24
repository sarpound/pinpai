// Hand-picked scenic running routes in cities people actually travel to.
// Each route starts at a real, findable point (lat/lng of the start), so the plan never relies on the AI or the
// geocoder guessing "a running spot" (that is how "Bennelong Park" ended up 11 km from the Opera House).
// The planner picks the routes closest to the hotel, a different one each morning.

export type RunRoute = { name: string; start: string; lat: number; lng: number; km: number; why: string };

export const RUN_ROUTES: RunRoute[] = [
  // Sydney
  { name: "Opera House → Mrs Macquarie's Chair", start: "Sydney Opera House forecourt", lat: -33.8572, lng: 151.2151, km: 5, why: "เลียบอ่าวผ่านโอเปร่าเฮาส์ ทะลุ Royal Botanic Garden ไปจุดชมวิวที่เห็นทั้งโอเปร่าเฮาส์และสะพานฮาร์เบอร์ แสงเช้าสวยสุด" },
  { name: "Bondi → Bronte coastal run", start: "Bondi Icebergs", lat: -33.8955, lng: 151.2745, km: 5, why: "ทางเลียบหน้าผาริมทะเล ไป–กลับ Bondi–Bronte วิวคลื่นและสระ Icebergs ขึ้นลงเนินนิดหน่อย" },
  { name: "Centennial Park Grand Drive", start: "Centennial Park (Paddington Gates)", lat: -33.8973, lng: 151.2340, km: 3.8, why: "ลูปวิ่งยอดนิยมของคนซิดนีย์ ทางเรียบ มีเลนวิ่งแยกจากรถ" },
  { name: "Barangaroo → Darling Harbour", start: "Barangaroo Reserve", lat: -33.8580, lng: 151.2017, km: 4, why: "ริมน้ำฝั่งตะวันตกของ CBD ทางเรียบ ผ่าน Barangaroo Reserve ถึง Darling Harbour" },
  { name: "Harbour Bridge → Kirribilli", start: "The Rocks (Cumberland St bridge stairs)", lat: -33.8587, lng: 151.2087, km: 5, why: "วิ่งข้ามสะพานฮาร์เบอร์บนทางเท้า ลงไปฝั่ง Kirribilli มุมโอเปร่าเฮาส์ที่คนส่วนใหญ่ไม่เคยเห็น" },
  // Melbourne
  { name: "The Tan (Royal Botanic Gardens)", start: "The Tan Track – Swan St Bridge", lat: -37.8304, lng: 144.9796, km: 3.8, why: "ลูปวิ่งที่ดังที่สุดของเมลเบิร์น รอบสวนพฤกษศาสตร์ ทางดินนุ่ม คนวิ่งเยอะตั้งแต่เช้า" },
  { name: "Yarra River Trail (Southbank → Birrarung Marr)", start: "Southbank Promenade", lat: -37.8203, lng: 144.9654, km: 5, why: "เลียบแม่น้ำยาร์รา เห็นสกายไลน์ CBD ทางเรียบ ไป–กลับได้" },
  { name: "Albert Park Lake loop", start: "Albert Park Lake (Aquatic Dr)", lat: -37.8459, lng: 144.9695, km: 5, why: "ลูปรอบทะเลสาบ 5 กม. พอดี ทางเรียบ วิวเมืองสะท้อนน้ำตอนเช้า" },
  { name: "St Kilda foreshore → Elwood", start: "St Kilda Pier", lat: -37.8679, lng: 144.9740, km: 5, why: "เลียบชายหาด St Kilda ลมทะเลเย็นสบาย ไป–กลับ Elwood" },
  // Shanghai
  { name: "The Bund → North Bund riverside", start: "The Bund (Chen Yi Square)", lat: 31.2397, lng: 121.4900, km: 5, why: "วิ่งริมแม่น้ำหวงผู่ ฝั่งตรงข้ามคือ Lujiazui ช่วงเช้าคนน้อย ก่อนนักท่องเที่ยวมา" },
  { name: "West Bund (Xuhui Riverside)", start: "West Bund Art Center", lat: 31.1785, lng: 121.4618, km: 6, why: "ทางวิ่งริมแม่น้ำยาวต่อเนื่อง กว้าง มีเลนวิ่งเฉพาะ บรรยากาศชิล" },
  { name: "Lujiazui Binjiang Avenue", start: "Lujiazui riverside (Binjiang Ave)", lat: 31.2400, lng: 121.5000, km: 5, why: "ริมน้ำฝั่งผู่ตง มองเห็นตึกเก่า The Bund ฝั่งตรงข้าม" },
  { name: "Century Park loop", start: "Century Park (Gate 1)", lat: 31.2192, lng: 121.5506, km: 5, why: "สวนใหญ่ร่มรื่น ทางวิ่งรอบสวน เงียบกว่าริมแม่น้ำ" },
  // Tokyo / Osaka / Kyoto
  { name: "Imperial Palace loop (Kokyo Run)", start: "Sakuradamon Gate", lat: 35.6783, lng: 139.7526, km: 5, why: "ลูปวิ่งที่ดังที่สุดในโตเกียว รอบพระราชวัง ไม่มีไฟแดงตลอดเส้น" },
  { name: "Yoyogi Park loop", start: "Yoyogi Park (Harajuku Gate)", lat: 35.6717, lng: 139.6949, km: 3, why: "สวนกลางเมือง ร่มรื่น ทางวิ่งรอบสวน ใกล้ชิบูย่า/ฮาราจูกุ" },
  { name: "Sumida River terrace", start: "Sumida Park (Asakusa)", lat: 35.7106, lng: 139.7999, km: 5, why: "เลียบแม่น้ำสุมิดะ เห็นโตเกียวสกายทรี" },
  { name: "Osaka Castle Park loop", start: "Osaka Castle Park (Morinomiya)", lat: 34.6873, lng: 135.5262, km: 4, why: "วิ่งรอบคูเมืองปราสาทโอซาก้า เช้าตรู่สวยมาก" },
  { name: "Kamo River path", start: "Sanjo Ohashi", lat: 35.0116, lng: 135.7716, km: 5, why: "ทางวิ่งริมแม่น้ำคาโมะ เรียบ เงียบ เห็นภูเขารอบเกียวโต" },
  // Seoul / Busan
  { name: "Han River – Banpo Hangang Park", start: "Banpo Hangang Park", lat: 37.5104, lng: 126.9960, km: 5, why: "ริมแม่น้ำฮัน ทางวิ่งกว้างยาว คนเกาหลีวิ่งกันเยอะ" },
  { name: "Cheonggyecheon stream", start: "Cheonggye Plaza", lat: 37.5696, lng: 126.9781, km: 5, why: "ทางเดิน-วิ่งริมลำธารกลางเมือง ต่ำกว่าระดับถนน ไม่มีรถ" },
  { name: "Namsan circuit", start: "Namsan Park (Bukcheon trail)", lat: 37.5512, lng: 126.9882, km: 5, why: "ทางวิ่งรอบเขานัมซาน ร่มรื่น มีเนิน ได้วิวเมือง" },
  // Bangkok / Chiang Mai / Phuket area
  { name: "Lumpini Park loop", start: "Lumpini Park (Rama IV gate)", lat: 13.7314, lng: 100.5413, km: 2.5, why: "ลูปวิ่งยอดนิยมของคนกรุงเทพฯ รอบละ 2.5 กม. เช้ามืดคนวิ่งเยอะ" },
  { name: "Benjakitti Forest Park", start: "Benjakitti Forest Park", lat: 13.7290, lng: 100.5580, km: 4, why: "สวนป่าใหม่ มีสกายวอล์ก ทางวิ่งรอบบึง" },
  { name: "Nong Buak Hard Park & moat", start: "Nong Buak Hard Public Park", lat: 18.7837, lng: 98.9814, km: 5, why: "วิ่งรอบสวนแล้วเลียบคูเมืองเก่าเชียงใหม่ อากาศเช้าเย็นสบาย" },
  // Singapore / Hong Kong / Taipei
  { name: "Marina Bay loop", start: "Merlion Park", lat: 1.2868, lng: 103.8545, km: 3.5, why: "ลูปรอบอ่าวมารีน่า ผ่านเมอร์ไลออน มารีน่าเบย์แซนด์ส ทางเรียบตลอด" },
  { name: "Gardens by the Bay East", start: "Gardens by the Bay East", lat: 1.2836, lng: 103.8722, km: 4, why: "ทางวิ่งริมน้ำ มองกลับมาเห็นวิว Marina Bay ทั้งแผง" },
  { name: "East Coast Park", start: "East Coast Park (Area C)", lat: 1.3009, lng: 103.9126, km: 5, why: "ทางวิ่งเลียบทะเลยาวหลายกิโล ลมเย็น" },
  { name: "Tsim Sha Tsui Promenade", start: "Avenue of Stars", lat: 22.2934, lng: 114.1720, km: 4, why: "ริมอ่าววิกตอเรีย เห็นสกายไลน์เกาะฮ่องกง ไป–กลับฮุงฮอม" },
  { name: "Bowen Road fitness trail", start: "Bowen Road (Wan Chai Gap)", lat: 22.2747, lng: 114.1710, km: 4, why: "ทางเรียบบนไหล่เขา ไม่มีรถ เห็นวิวเมืองระหว่างต้นไม้" },
  { name: "Daan Forest Park loop", start: "Daan Park", lat: 25.0300, lng: 121.5358, km: 2.5, why: "สวนใหญ่ใจกลางไทเป ทางวิ่งรอบสวน" },
  { name: "Dadaocheng riverside", start: "Dadaocheng Wharf", lat: 25.0560, lng: 121.5080, km: 5, why: "เลียบแม่น้ำตั้นสุ่ย ทางจักรยาน/วิ่งยาว" },
  // Europe / US
  { name: "Hyde Park & Kensington Gardens", start: "Hyde Park Corner", lat: 51.5027, lng: -0.1527, km: 5, why: "ลูปสวนกลางลอนดอน ผ่าน Serpentine และ Kensington Palace" },
  { name: "Thames Path (South Bank)", start: "Westminster Bridge (South Bank)", lat: 51.5008, lng: -0.1200, km: 5, why: "เลียบแม่น้ำเทมส์ ผ่าน London Eye ถึง Tower Bridge" },
  { name: "Seine quays → Eiffel Tower", start: "Pont de l'Alma", lat: 48.8638, lng: 2.3011, km: 5, why: "เลียบแม่น้ำแซน ไปวนสนาม Champ de Mars ใต้หอไอเฟล เช้าตรู่คนน้อย" },
  { name: "Jardin du Luxembourg loop", start: "Jardin du Luxembourg", lat: 48.8462, lng: 2.3372, km: 2, why: "สวนสวยที่คนปารีสวิ่งกันจริง รอบละ ~2 กม." },
  { name: "Central Park loop", start: "Columbus Circle", lat: 40.7681, lng: -73.9819, km: 6, why: "ลูปในเซ็นทรัลพาร์ค เช้าตรู่ปิดถนนให้คนวิ่ง/ปั่น" },
  { name: "Hudson River Greenway", start: "Pier 45 (West Village)", lat: 40.7330, lng: -74.0110, km: 5, why: "เลียบแม่น้ำฮัดสัน ทางเรียบยาว มองเห็นนิวเจอร์ซีย์" },
  // China (others) / Vietnam
  { name: "West Lake – Su Causeway", start: "Su Causeway (south end)", lat: 30.2470, lng: 120.1460, km: 5, why: "วิ่งบนคันทางกลางทะเลสาบซีหู เช้าตรู่หมอกบางๆ สวยมาก" },
  { name: "West Lake – Bai Causeway & Beishan Road", start: "Broken Bridge (断桥)", lat: 30.2603, lng: 120.1530, km: 5, why: "สะพานขาด → ไป่ตี → เกาะกูซาน → ถนนเป่ยซาน ริมน้ำทั้งเส้น เห็นเจดีย์เป่าฉู" },
  { name: "West Lake – Yanggong Causeway", start: "Yanggong Causeway (north end)", lat: 30.2468, lng: 120.1335, km: 6, why: "คันทางฝั่งตะวันตก คนน้อยกว่าซูตี้ ผ่านสวนและสะพานหิน ร่มรื่น" },
  { name: "Hubin – Lakeside promenade", start: "Hubin Music Fountain (湖滨)", lat: 30.2571, lng: 120.1560, km: 4, why: "ทางเดินริมทะเลสาบฝั่งเมือง เรียบ ไฟสว่าง เหมาะวิ่งเช้ามืด" },
  { name: "Qiantang River Greenway", start: "Six Harmonies Pagoda (六和塔)", lat: 30.1990, lng: 120.1310, km: 6, why: "ทางวิ่งริมแม่น้ำเฉียนถัง กว้าง ลมเย็น วิวเจดีย์หกประสาน" },
  { name: "Olympic Forest Park", start: "Olympic Forest Park (South Gate)", lat: 40.0167, lng: 116.3889, km: 5, why: "ทางวิ่งยางเฉพาะในสวนใหญ่ของปักกิ่ง" },
  { name: "My Khe Beach", start: "My Khe Beach", lat: 16.0610, lng: 108.2470, km: 5, why: "วิ่งเลียบหาดยาวของดานัง เช้าตรู่ลมเย็น" },
];

const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};

/** curated routes near the hotel, closest first; walkable/short-ride ones (≤4 km) before the rest (≤12 km) */
export function runRoutesNear(hotel: { lat: number; lng: number }, max = 12) {
  // within reach (≤4 km) the list order wins (each city's most iconic route is listed first); further ones by distance
  return RUN_ROUTES.map((r, i) => ({ r, i, d: dist(hotel, r) })).filter((x) => x.d <= max)
    .sort((a, b) => Number(a.d > 4) - Number(b.d > 4) || (a.d <= 4 ? a.i - b.i : a.d - b.d)).map((x) => ({ ...x.r, fromHotelKm: Math.round(x.d * 10) / 10 }));
}

/** minutes a relaxed tourist run takes, with warm-up and stretching */
export const runMinutes = (km: number) => Math.round(km * 7 + 15);

// Money helpers: everything is stored in THB; local currency is only an input convenience.
export const CURRENCIES: { code: string; sym: string; th: string; match: RegExp }[] = [
  { code: "CNY", sym: "¥", th: "หยวน", match: /จีน|china|beijing|shanghai|hangzhou|chengdu|xi'?an|guangzhou|shenzhen|chongqing|หางโจว|ปักกิ่ง|เซี่ยงไฮ้|เฉิงตู|ฉงชิ่ง/i },
  { code: "JPY", sym: "¥", th: "เยน", match: /ญี่ปุ่น|japan|tokyo|osaka|kyoto|hokkaido|fukuoka|โตเกียว|โอซาก้า|เกียวโต/i },
  { code: "KRW", sym: "₩", th: "วอน", match: /เกาหลี|korea|seoul|busan|jeju|โซล|ปูซาน|เชจู/i },
  { code: "TWD", sym: "NT$", th: "ดอลลาร์ไต้หวัน", match: /ไต้หวัน|taiwan|taipei|ไทเป/i },
  { code: "HKD", sym: "HK$", th: "ดอลลาร์ฮ่องกง", match: /ฮ่องกง|hong kong/i },
  { code: "MOP", sym: "MOP", th: "ปาตากา", match: /มาเก๊า|macau|macao/i },
  { code: "SGD", sym: "S$", th: "ดอลลาร์สิงคโปร์", match: /สิงคโปร์|singapore/i },
  { code: "MYR", sym: "RM", th: "ริงกิต", match: /มาเลเซีย|malaysia|kuala lumpur|penang|กัวลาลัมเปอร์|ปีนัง/i },
  { code: "VND", sym: "₫", th: "ด่ง", match: /เวียดนาม|vietnam|hanoi|ho chi minh|da nang|ฮานอย|โฮจิมินห์|ดานัง/i },
  { code: "LAK", sym: "₭", th: "กีบ", match: /ลาว|laos|vientiane|luang prabang|เวียงจันทน์|หลวงพระบาง/i },
  { code: "IDR", sym: "Rp", th: "รูเปียห์", match: /อินโดนีเซีย|indonesia|bali|jakarta|บาหลี/i },
  { code: "PHP", sym: "₱", th: "เปโซ", match: /ฟิลิปปินส์|philippines|manila|cebu|เซบู/i },
  { code: "INR", sym: "₹", th: "รูปี", match: /อินเดีย|india|delhi|mumbai/i },
  { code: "AUD", sym: "A$", th: "ดอลลาร์ออสเตรเลีย", match: /ออสเตรเลีย|australia|sydney|melbourne|ซิดนีย์/i },
  { code: "GBP", sym: "£", th: "ปอนด์", match: /อังกฤษ|united kingdom|\buk\b|london|ลอนดอน/i },
  { code: "EUR", sym: "€", th: "ยูโร", match: /ฝรั่งเศส|france|paris|เยอรมนี|germany|อิตาลี|italy|สเปน|spain|เนเธอร์แลนด์|netherlands|สวิตเซอร์แลนด์|ยุโรป|europe|ปารีส/i },
  { code: "USD", sym: "$", th: "ดอลลาร์", match: /อเมริกา|united states|usa|new york|los angeles|hawaii|นิวยอร์ก/i },
];
export function guessCurrency(dest: string | null | undefined) {
  if (!dest || /ประเทศไทย|thailand/i.test(dest)) return null;
  return CURRENCIES.find((c) => c.match.test(dest)) ?? null;
}
export const baht = (n: number) => `฿${Math.round(n).toLocaleString("en-US")}`;

export type Bal = { id: string; paid: number; share: number; net: number };
export function balances(members: string[], expenses: { paid_by: string | null; amount: number; split: string[] }[]): Bal[] {
  const m = new Map(members.map((id) => [id, { id, paid: 0, share: 0, net: 0 }]));
  for (const e of expenses) {
    const split = e.split.filter((x) => m.has(x));
    const who = split.length ? split : members;
    if (e.paid_by && m.has(e.paid_by)) m.get(e.paid_by)!.paid += e.amount;
    for (const x of who) m.get(x)!.share += e.amount / who.length;
  }
  for (const b of m.values()) b.net = b.paid - b.share;
  return [...m.values()];
}
/** Fewest transfers that settle everyone (greedy, fine for a group of friends). */
export function settle(bals: Bal[]) {
  const cred = bals.filter((b) => b.net > 0.5).map((b) => ({ ...b })).sort((a, b) => b.net - a.net);
  const debt = bals.filter((b) => b.net < -0.5).map((b) => ({ ...b, net: -b.net })).sort((a, b) => b.net - a.net);
  const out: { from: string; to: string; amount: number }[] = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].net, cred[j].net);
    out.push({ from: debt[i].id, to: cred[j].id, amount: x });
    debt[i].net -= x; cred[j].net -= x;
    if (debt[i].net < 0.5) i++;
    if (cred[j].net < 0.5) j++;
  }
  return out;
}

"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Input, Label } from "@/components/ui/Field";
import type { PlanJob, Prefs } from "@/lib/types";

const STYLES: [string, string][] = [
  ["food", "ของกินร้านดัง"], ["cafe", "คาเฟ่"], ["nature", "ธรรมชาติ วิวสวย"], ["culture", "วัด/วัฒนธรรม"],
  ["shopping", "ช้อปปิ้ง"], ["nightlife", "เที่ยวกลางคืน"], ["photo", "จุดถ่ายรูป"], ["activity", "กิจกรรม/ผจญภัย"], ["themepark", "สวนสนุก/ธีมพาร์ค"], ["market", "ตลาด/ตลาดนัดกลางคืน"],
];
const FOOD: [string, string][] = [["local", "อาหารท้องถิ่น"], ["street", "สตรีทฟู้ด"], ["famous", "ร้านดัง/มิชลิน"], ["seafood", "ซีฟู้ด"],
  ["thai", "มีอาหารไทยบ้าง"], ["mild", "ไม่เผ็ด"], ["halal", "ฮาลาล"], ["veg", "มังสวิรัติ/เจ"]];
const WANTS: [string, string][] = [["run", "🏃 วิ่งตอนเช้า"], ["massage", "💆 นวด/สปา"], ["sunset", "🌇 ดูพระอาทิตย์ตก"], ["sunrise", "🌅 ดูพระอาทิตย์ขึ้น"], ["hike", "🥾 เดินป่า/เดินเขา"], ["bike", "🚲 ปั่นจักรยาน"],
  ["onsen", "♨️ ออนเซ็น/น้ำพุร้อน"], ["beach", "🏖️ ทะเล/ว่ายน้ำ"], ["show", "🎭 ดูโชว์/คอนเสิร์ต"], ["cooking", "🍳 เวิร์กช็อป/เรียนทำอาหาร"], ["museum", "🖼️ พิพิธภัณฑ์"], ["kids", "🧒 กิจกรรมเด็ก"]];
const WHO: [string, string, string][] = [["friends", "🍻 แก๊งเพื่อน", "สนุก กินเยอะ"], ["date", "💕 เดตกับแฟน", "โรแมนติก วิวสวย"], ["family", "👨‍👩‍👧 ครอบครัว", "เดินไม่หนัก มีเด็ก/ผู้ใหญ่"], ["solo", "🎒 ไปคนเดียว", "คล่องตัว"]];
const MEALS: [string, string, string][] = [["breakfast", "เช้า", "07:30–09:00"], ["lunch", "กลางวัน", "11:30–13:30"], ["dinner", "เย็น", "18:00–20:00"],
  ["snack", "คาเฟ่/ของหวาน", "บ่าย"], ["late", "มื้อดึก", "หลัง 21:00"]];
const PACE: [string, string, string][] = [["relaxed", "ชิลๆ", "3–4 ที่/วัน"], ["normal", "กำลังดี", "4–5 ที่/วัน"], ["packed", "จัดเต็ม", "6–7 ที่/วัน"]];
const MODES: [string, string][] = [["transit", "รถไฟฟ้า/รถเมล์"], ["taxi", "แท็กซี่/Grab"], ["drive", "ขับรถเอง"], ["walk", "เดินเป็นหลัก"]];
const BUDGET: [string, string][] = [["budget", "ประหยัด"], ["mid", "กลางๆ"], ["luxury", "จัดเต็ม"]];
const STEPS = ["อ่านสไตล์ทริปของคุณ", "เลือกที่เที่ยวและร้านเด็ด", "จัดเส้นทางให้ไม่ย้อนไปมา", "ตรวจเวลาและมื้ออาหารทีละวัน", "หาที่พักที่อยู่ใกล้แผน", "ปักหมุดลงแผนที่"];

function Chip({ on, onClick, children, sub }: { on: boolean; onClick: () => void; children: React.ReactNode; sub?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`min-h-11 rounded-[14px] border px-3.5 py-2 text-left text-[14px] font-medium transition-colors ${on ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink hover:bg-sunken"}`}>
      {children}{sub && <span className={`block text-[11px] font-normal ${on ? "text-white/70" : "text-muted"}`}>{sub}</span>}
    </button>
  );
}

type Draft = Partial<{ styles: string[]; pace: string; mode: string; budget: string; cap: string; travelers: number; who: string; food: string[]; must: string; meals: string[]; note: string; wants: string[]; arrive: string; depart: string }>;
const draftKey = (id: string) => `pinpai.plandraft.${id}`;

export default function PlannerPanel({ tripId, token, prefs: saved, job, hasDates, hasPlaces, onStarted, onNeedDates, onBack }: {
  tripId: string; token: string; prefs: Prefs; job: PlanJob | null | undefined; hasDates: boolean; hasPlaces: boolean;
  onStarted: () => void; onNeedDates: () => void; onBack: () => void;
}) {
  // choices survive closing the panel / app (kept on this phone until planning starts)
  const [d0] = useState<Draft>(() => { try { return JSON.parse(localStorage.getItem(draftKey(tripId)) ?? "{}"); } catch { return {}; } });
  const prefs: Prefs = { ...saved, ...(d0.styles ? { styles: d0.styles } : {}), ...(d0.pace ? { pace: d0.pace } : {}), ...(d0.mode ? { mode: d0.mode as Prefs["mode"] } : {}),
    ...(d0.budget ? { budget: d0.budget } : {}), ...(d0.travelers ? { travelers: d0.travelers } : {}), ...(d0.who ? { companions: d0.who } : {}),
    ...(d0.food ? { food: d0.food } : {}), ...(d0.must != null ? { must: d0.must } : {}), ...(d0.meals ? { meals: d0.meals } : {}), ...(d0.note != null ? { note: d0.note } : {}), ...(d0.wants ? { wants: d0.wants } : {}), ...(d0.arrive != null ? { arrive_time: d0.arrive || null } : {}), ...(d0.depart != null ? { depart_time: d0.depart || null } : {}) };
  const [styles, setStyles] = useState<string[]>(prefs.styles?.length ? prefs.styles : ["food", "culture", "cafe"]);
  const [pace, setPace] = useState(prefs.pace ?? "normal");
  const [mode, setMode] = useState(prefs.mode ?? "taxi");
  const [budget, setBudget] = useState(prefs.budget ?? "mid");
  const [cap, setCap] = useState(d0.cap ?? (prefs.budget_amount && (prefs.budget_per ?? "person") === "person" ? String(prefs.budget_amount) : ""));
  const [travelers, setTravelers] = useState(prefs.travelers ?? 2);
  const [who, setWho] = useState(prefs.companions ?? "friends");
  const [food, setFood] = useState<string[]>(prefs.food ?? ["local"]);
  const [must, setMust] = useState(prefs.must ?? "");
  const [meals, setMeals] = useState<string[]>(prefs.meals?.length ? prefs.meals : ["breakfast", "lunch", "dinner"]);
  function pickWho(k: string) {
    setWho(k);
    if (k === "date") { setTravelers(2); setStyles((s) => [...new Set([...s.filter((x) => x !== "nightlife"), "photo", "cafe"])]); }
    if (k === "solo") setTravelers(1);
    if (k === "family" && pace === "packed") setPace("normal");
  }
  const [note, setNote] = useState(prefs.note ?? "");
  const [wants, setWants] = useState<string[]>(prefs.wants ?? []);
  const [arrive, setArrive] = useState(prefs.arrive_time ?? "");
  const [depart, setDepart] = useState(prefs.depart_time ?? "");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = job?.state === "running" && Date.now() - Date.parse(job.started_at) < 6 * 60_000;
  const busy = sending || running;

  useEffect(() => {
    try { localStorage.setItem(draftKey(tripId), JSON.stringify({ styles, pace, mode, budget, cap, travelers, who, food, must, meals, note, wants, arrive, depart })); } catch {}
  }, [tripId, styles, pace, mode, budget, cap, travelers, who, food, must, meals, note, wants, arrive, depart]);

  // progress follows the server's clock, so it is right after leaving and coming back
  const [, tick] = useState(0);
  useEffect(() => { if (!busy) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [busy]);
  const elapsed = running ? (Date.now() - Date.parse(job!.started_at)) / 1000 : 0;
  const step = Math.min(STEPS.length - 1, Math.floor(elapsed / 8));

  async function go() {
    if (busy) return; // double taps
    setErr(null);
    setSending(true);
    try {
      await api(`/api/trips/${tripId}/plan`, { token, body: { styles, pace, mode, budget, travelers, note, companions: who, meals, food, must, wants, arrive_time: arrive || null, depart_time: depart || null,
        ...(Number(cap) > 0 ? { budget_amount: Number(cap), budget_per: "person" } : {}) } });
      try { localStorage.removeItem(draftKey(tripId)); } catch {}
      onStarted();
    } catch (e) {
      setErr((e as Error).message);
      if ((e as { status?: number }).status === 409) onStarted(); // someone else is already planning — just follow along
    }
    setSending(false);
  }

  if (!hasDates) {
    return (
      <div className="space-y-3">
        <p className="text-muted">ต้องรู้วันไป–กลับก่อน ถึงจะจัดแผนรายวันให้ได้</p>
        <Button onClick={onNeedDates} className="w-full">ตั้งวันเดินทาง</Button>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="py-6" role="status" aria-live="polite">
        <div className="mx-auto size-12 animate-spin rounded-full border-4 border-line border-t-ink" aria-hidden />
        <ol className="mx-auto mt-6 max-w-[280px] space-y-2.5">
          {STEPS.map((s, i) => (
            <li key={s} className={`flex items-center gap-2.5 text-[14px] ${i < step ? "text-muted line-through" : i === step ? "font-semibold text-ink" : "text-muted/60"}`}>
              <span className={`size-2 rounded-full ${i <= step ? "bg-ink" : "bg-line"}`} />{s}
            </li>
          ))}
        </ol>
        <p className="mt-6 text-center text-[13px] text-muted">ใช้เวลาราว 30–60 วินาที{job?.by ? ` · ${job.by} เป็นคนกดจัด` : ""}</p>
        <p className="mx-auto mt-3 max-w-[300px] rounded-[14px] bg-sunken px-3 py-2 text-center text-[13px] text-ink">
          ปิดแอป ย้อนกลับ หรือเน็ตหลุดได้ ระบบจัดต่อให้ เสร็จแล้วแผนจะขึ้นเอง และทุกคนในทริปจะเห็นพร้อมกัน
        </p>
        <div className="mt-4 text-center"><Button variant="secondary" size="sm" onClick={onBack}>กลับไปดูแผนระหว่างรอ</Button></div>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-2">
      {job?.state === "running" && !running && (
        <p role="alert" className="rounded-[14px] bg-danger/10 px-3 py-2 text-[14px] text-danger">ครั้งก่อนใช้เวลานานผิดปกติจนหยุดไป ตัวเลือกยังอยู่ครบ กดจัดใหม่ได้เลย</p>
      )}
      {job?.state === "error" && (
        <p role="alert" className="rounded-[14px] bg-danger/10 px-3 py-2 text-[14px] text-danger">ครั้งก่อน{job.message ? `: ${job.message}` : "จัดไม่สำเร็จ"} ตัวเลือกยังอยู่ครบ กดจัดใหม่ได้เลย</p>
      )}
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">ไปกับใคร</h3>
        <div className="grid grid-cols-2 gap-2">{WHO.map(([k, l, sub]) => <Chip key={k} on={who === k} onClick={() => pickWho(k)} sub={sub}>{l}</Chip>)}</div>
      </section>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">อยากเที่ยวแนวไหน <span className="font-normal text-muted">เลือกได้หลายอัน</span></h3>
        <div className="grid grid-cols-2 gap-2">
          {STYLES.map(([k, l]) => <Chip key={k} on={styles.includes(k)} onClick={() => setStyles((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))}>{l}</Chip>)}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">จังหวะการเที่ยว</h3>
        <div className="grid grid-cols-3 gap-2">{PACE.map(([k, l, sub]) => <Chip key={k} on={pace === k} onClick={() => setPace(k)} sub={sub}>{l}</Chip>)}</div>
      </section>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">มื้ออาหารที่ให้จัดร้าน <span className="font-normal text-muted">แนะนำ 3 มื้อ</span></h3>
        <div className="grid grid-cols-3 gap-2">
          {MEALS.map(([k, l, sub]) => <Chip key={k} on={meals.includes(k)} sub={sub} onClick={() => setMeals((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]))}>{l}</Chip>)}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">อยากกินแนวไหน <span className="font-normal text-muted">ไม่เลือกก็ได้</span></h3>
        <div className="grid grid-cols-2 gap-2">
          {FOOD.map(([k, l]) => <Chip key={k} on={food.includes(k)} onClick={() => setFood((f) => (f.includes(k) ? f.filter((x) => x !== k) : [...f, k]))}>{l}</Chip>)}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">กิจกรรมที่อยากทำ <span className="font-normal text-muted">ระบบจะหาที่และเวลาที่เหมาะให้</span></h3>
        <div className="grid grid-cols-2 gap-2">
          {WANTS.map(([k, l]) => <Chip key={k} on={wants.includes(k)} onClick={() => setWants((w) => (w.includes(k) ? w.filter((x) => x !== k) : [...w, k]))}>{l}</Chip>)}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">เวลาไปถึงและเวลากลับ <span className="font-normal text-muted">ไม่ใส่ก็ได้</span></h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-[13px] text-muted">ถึงปลายทางวันแรก
            <input type="time" value={arrive} onChange={(e) => setArrive(e.target.value)} className="mt-1 h-11 w-full rounded-[14px] border border-line bg-surface px-3 text-[16px] text-ink tnum" />
          </label>
          <label className="block text-[13px] text-muted">เครื่อง/รถออกวันสุดท้าย
            <input type="time" value={depart} onChange={(e) => setDepart(e.target.value)} className="mt-1 h-11 w-full rounded-[14px] border border-line bg-surface px-3 text-[16px] text-ink tnum" />
          </label>
        </div>
        {(arrive || depart) && <button type="button" onClick={() => { setArrive(""); setDepart(""); }} className="mt-1.5 min-h-9 text-[13px] font-medium text-accent underline-offset-2 hover:underline">ล้างเวลา (ยังไม่รู้เที่ยวบิน)</button>}
        <p className="mt-1.5 text-[12px] text-muted">ใส่เฉพาะเมื่อรู้เวลาเที่ยวบินจริง ถ้าแตะแล้วเครื่องเติมเวลาปัจจุบันให้เอง กดล้างได้ · ใส่แล้ววันแรกจะเริ่มหลังเครื่องลง และวันสุดท้ายจะจบให้ทันไปสนามบินก่อนเวลา 2 ชม.ครึ่ง</p>
      </section>
      <div>
        <Label htmlFor="plan-must" hint="คั่นด้วยจุลภาค">ที่ที่ต้องไปให้ได้</Label>
        <Input id="plan-must" value={must} onChange={(e) => setMust(e.target.value)} maxLength={300} placeholder="เช่น ดิสนีย์แลนด์, ร้านข้าวซอยลำดวน, จุดชมวิวดอยสุเทพ" />
      </div>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">เดินทางในเมืองด้วย</h3>
        <div className="grid grid-cols-2 gap-2">{MODES.map(([k, l]) => <Chip key={k} on={mode === k} onClick={() => setMode(k as Prefs["mode"] & string)}>{l}</Chip>)}</div>
      </section>
      <section className="grid grid-cols-[1fr_auto] items-end gap-3">
        <div>
          <h3 className="mb-2 text-[15px] font-semibold">งบที่พักและกิน</h3>
          <div className="grid grid-cols-3 gap-2">{BUDGET.map(([k, l]) => <Chip key={k} on={budget === k} onClick={() => setBudget(k)}>{l}</Chip>)}</div>
        </div>
        <div>
          <h3 className="mb-2 text-[15px] font-semibold">กี่คน</h3>
          <div className="flex h-11 items-center rounded-[14px] border border-line">
            <button type="button" className="h-full w-10 text-[18px]" onClick={() => setTravelers((n) => Math.max(1, n - 1))} aria-label="ลดจำนวนคน">−</button>
            <span className="w-6 text-center font-semibold tnum" aria-live="polite">{travelers}</span>
            <button type="button" className="h-full w-10 text-[18px]" onClick={() => setTravelers((n) => Math.min(20, n + 1))} aria-label="เพิ่มจำนวนคน">+</button>
          </div>
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">งบต่อคนทั้งทริป <span className="font-normal text-muted">(ไม่ใส่ก็ได้)</span></h3>
        <label className="flex h-12 items-center rounded-full border border-line bg-surface px-4 focus-within:border-ink">
          <span className="mr-1 font-semibold">฿</span>
          <input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ""))} placeholder="เช่น 20000 รวมตั๋วเครื่องบินและที่พัก"
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none focus-visible:outline-none tnum" aria-label="งบต่อคน" />
        </label>
      </section>
      <div>
        <Label htmlFor="plan-note" hint="ไม่ใส่ก็ได้">มีอะไรอยากบอกเพิ่ม</Label>
        <Input id="plan-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="เช่น ไม่กินเผ็ด อยากขึ้นกระเช้า มีผู้สูงอายุ" />
      </div>
      {hasPlaces && <p className="rounded-[14px] bg-sunken px-3 py-2 text-[13px] text-muted">จัดใหม่จะแทนแผนเดิมที่ระบบเคยจัดให้ ส่วนที่ที่เพื่อนเพิ่มเอง กดหัวใจ หรือติ๊กว่าไปแล้ว จะอยู่ครบ</p>}
      {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}
      <div className="sticky bottom-0 -mx-4 border-t border-line bg-surface px-4 pb-1 pt-3">
        <Button onClick={go} className="w-full">จัดทริปให้เลย</Button>
      </div>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, forgetSession, getName, getSessions, saveSession, setName, type Session } from "@/lib/client/api";
import { Button, Input, Label, Toast } from "@/components/ui/Field";
import DayStrip from "@/components/DayStrip";
import DestinationInput, { type Dest } from "@/components/DestinationInput";
import { IconChevronRight, IconLink, IconTrash, IconVideo } from "@/components/icons";

function today(offset = 0) {
  const d = new Date(Date.now() + offset * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Home() {
  const router = useRouter();
  const [trips, setTrips] = useState<[string, Session][]>([]);
  const [destSel, setDestSel] = useState<Dest>({ name: "", lat: null, lng: null });
  const dest = destSel.name;
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [name, setNm] = useState("");
  const [link, setLink] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setTrips(Object.entries(getSessions()).sort((a, b) => b[1].savedAt - a[1].savedAt));
    setNm(getName());
    const clip = new URLSearchParams(location.search).get("clip"); // from the share sheet
    if (clip) setLink(clip);
    const s = today(14), e = today(16);
    setStart(s);
    setEnd(e);
  }, []);

  const [confirm, setConfirm] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  async function removeTrip(id: string, s: Session) {
    setRemoving(id);
    try {
      if (s.role === "editor") await api(`/api/trips/${id}/leave`, { token: s.token, body: {} });
      else {
        // older entries don't know their role: try deleting, fall back to leaving
        try { await api(`/api/trips/${id}`, { token: s.token, method: "DELETE" }); }
        catch (e) { if ((e as { status?: number }).status !== 403) throw e; await api(`/api/trips/${id}/leave`, { token: s.token, body: {} }); }
      }
      setToast(s.role === "editor" ? "ออกจากทริปแล้ว" : "ลบทริปแล้ว");
    } catch (e) {
      const st = (e as { status?: number }).status;
      // trip already gone / link no longer valid → just tidy the list; otherwise explain
      if (st !== 401 && st !== 404) { setToast((e as Error).message); setRemoving(null); setConfirm(null); return; }
      setToast("เอาออกจากรายการแล้ว");
    }
    forgetSession(id);
    setTrips(Object.entries(getSessions()).sort((a, b) => b[1].savedAt - a[1].savedAt));
    setRemoving(null); setConfirm(null);
    window.setTimeout(() => setToast(null), 2400);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!dest.trim()) return setErr("ใส่จุดหมายก่อน เช่น เชียงใหม่ หรือ โตเกียว");
    if (!name.trim()) return setErr("ใส่ชื่อเล่นของคุณ เพื่อนจะได้รู้ว่าใครเพิ่มอะไร");
    if (start && end && end < start) return setErr("วันกลับต้องไม่ก่อนวันไป");
    setBusy(true);
    try {
      const r = await api<{ tripId: string; memberId: string; token: string }>("/api/trips", {
        body: { title: `เที่ยว${dest.trim()}`, destination: dest.trim(), dest_lat: destSel.lat, dest_lng: destSel.lng, start_date: start || null, end_date: end || null, name: name.trim() },
      });
      setName(name.trim());
      saveSession(r.tripId, { token: r.token, memberId: r.memberId, title: `เที่ยว${dest.trim()}`, role: "owner" });
      const q = link.trim() ? `?import=${encodeURIComponent(link.trim())}` : start && end ? "?plan=1" : "";
      router.push(`/t/${r.tripId}${q}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim().replace(/^.*\/join\//, "").toUpperCase();
    if (c.length < 6) return setToast("โค้ดเชิญมี 8 ตัวอักษร");
    router.push(`/join/${c}`);
  }

  return (
    <main className="mx-auto min-h-dvh max-w-[1120px] px-4 pb-16 pt-5 md:px-8 md:pt-8">
      <header className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5" aria-label="ปักไป หน้าแรก">
          <img src="/icon.svg" alt="" className="size-9 rounded-[10px]" />
          <span className="font-display text-[22px] font-semibold tracking-normal">ปักไป</span>
        </Link>
      </header>

      <div className="mt-6 grid items-start gap-4 md:mt-10 md:grid-cols-[1.15fr_.85fr] md:gap-6">
        <section aria-labelledby="new-trip" className="rounded-[28px] bg-surface p-5 shadow-[var(--shadow-2)] md:p-8">
          <h1 id="new-trip" className="font-display text-[30px] font-semibold leading-[38px] md:text-[40px] md:leading-[50px]">
            ทริปหน้าไปไหนดี
          </h1>
          <p className="mt-2 max-w-[46ch] text-muted">
            ปักหมุดที่อยากไป วางลิงก์คลิปเที่ยวให้ระบบหาสถานที่ให้ แล้วชวนเพื่อนมาจัดวันด้วยกันบนแผนที่เดียว
          </p>

          <form onSubmit={create} className="mt-7 space-y-5" noValidate>
            <div>
              <Label htmlFor="dest">จะไปที่ไหน</Label>
              <DestinationInput id="dest" value={destSel} onChange={setDestSel} placeholder="เช่น เชียงใหม่, ภูเก็ต, โอซาก้า" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <Label htmlFor="start">วันไป</Label>
                <Input id="start" type="date" value={start} onChange={(e) => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); }} />
              </div>
              <div className="min-w-0">
                <Label htmlFor="end">วันกลับ</Label>
                <Input id="end" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            {start && end >= start && (
              <div className="rounded-[16px] bg-sunken px-3 pb-2 pt-3">
                <DayStrip start={start} end={end} />
              </div>
            )}
            <div>
              <Label htmlFor="name" hint="เพื่อนจะเห็นชื่อนี้">ชื่อเล่นของคุณ</Label>
              <Input id="name" value={name} onChange={(e) => setNm(e.target.value)} placeholder="เช่น ปอนด์" maxLength={40} autoComplete="nickname" />
            </div>
            <div>
              <Label htmlFor="link" hint="ไม่ใส่ก็ได้">มีคลิปที่อยากไปตามอยู่แล้ว?</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"><IconVideo size={18} /></span>
                <Input id="link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="วางลิงก์ TikTok, Reels หรือ Shorts ตรงนี้" className="pl-10" inputMode="url" />
              </div>
            </div>
            {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}
            <Button type="submit" disabled={busy} className="w-full md:w-auto md:min-w-56">
              {busy ? "กำลังสร้างทริป…" : "เริ่มทริปใหม่"}
            </Button>
          </form>
        </section>

        <aside className="space-y-4">
          <section aria-labelledby="my-trips" className="rounded-[24px] bg-surface p-5 shadow-[var(--shadow-1)]">
            <h2 id="my-trips" className="text-[17px] font-semibold">ทริปของฉัน</h2>
            {trips.length === 0 ? (
              <p className="mt-2 text-[14px] text-muted">ยังไม่มีทริปในเครื่องนี้ สร้างใหม่ หรือเข้าทริปที่เพื่อนชวนได้เลย</p>
            ) : (
              <ul className="mt-3 divide-y divide-line overflow-hidden rounded-[16px] border border-line">
                {trips.map(([id, s]) => (
                  <li key={id}>
                    {confirm === id ? (
                      <div className="bg-[#FFF4F2] px-4 py-3">
                        <p className="text-[14px] font-semibold">{s.role === "editor" ? `ออกจาก “${s.title ?? "ทริป"}”?` : `ลบ “${s.title ?? "ทริป"}”?`}</p>
                        <p className="mt-0.5 text-[12px] text-muted">{s.role === "editor" ? "ทริปยังอยู่สำหรับเพื่อน ถ้าจะกลับมาต้องขอลิงก์เชิญใหม่" : s.role === "owner" ? "แผน ค่าใช้จ่าย และตำแหน่งจะหายสำหรับทุกคนในทริป กู้คืนไม่ได้" : "ถ้าคุณเป็นคนสร้าง ทริปจะถูกลบสำหรับทุกคน ถ้าเพื่อนสร้าง คุณจะออกจากทริป"}</p>
                        <div className="mt-2.5 flex gap-2">
                          <button onClick={() => setConfirm(null)} className="h-10 flex-1 rounded-full border border-line bg-surface text-[14px] font-semibold">ยกเลิก</button>
                          <button onClick={() => removeTrip(id, s)} disabled={removing === id} className="h-10 flex-1 rounded-full bg-danger text-[14px] font-semibold text-white">
                            {removing === id ? "กำลังลบ…" : s.role === "editor" ? "ออกจากทริป" : "ลบทริป"}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center hover:bg-sunken">
                        <Link href={`/t/${id}`} className="flex min-w-0 flex-1 items-center gap-3 py-3.5 pl-4">
                          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-sunken text-ink"><IconChevronRight size={18} /></span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{s.title ?? "ทริป"}</span>
                            <span className="block text-[12px] text-muted">{s.role === "owner" ? "ทริปของคุณ · " : ""}เปิดล่าสุด {new Date(s.savedAt).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}</span>
                          </span>
                        </Link>
                        <button onClick={() => setConfirm(id)} className="mr-2 grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-line/60 hover:text-danger"
                          aria-label={`${s.role === "editor" ? "ออกจาก" : "ลบ"}ทริป ${s.title ?? ""}`}><IconTrash size={18} /></button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="join" className="rounded-[24px] bg-surface p-5 shadow-[var(--shadow-1)]">
            <h2 id="join" className="text-[17px] font-semibold">เพื่อนชวนมา?</h2>
            <form onSubmit={join} className="mt-3 flex gap-2">
              <label htmlFor="code" className="sr-only">ลิงก์หรือโค้ดเชิญ</label>
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"><IconLink size={18} /></span>
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="วางลิงก์หรือโค้ดเชิญ" className="pl-10" autoCapitalize="characters" />
              </div>
              <Button type="submit" variant="secondary">เข้าทริป</Button>
            </form>
          </section>

          <section className="rounded-[24px] bg-ink p-5 text-[14px] text-white/75">
            <h2 className="text-[15px] font-semibold text-white">สีของแต่ละวัน</h2>
            <div className="mt-3 flex items-center">{["#D92D3A","#F2B705","#D6337F","#1B7A43","#C2540A","#2563C9","#7A3FC2"].map((c, i, a) => (<span key={c} className="flex items-center"><span className="size-4 rounded-full ring-2 ring-ink" style={{ background: c }} />{i < a.length - 1 && <span className="h-[3px] w-5" style={{ background: c }} />}</span>))}</div>
            <p className="mt-3">เส้นทางแต่ละวันใช้สีประจำวันแบบไทย วันเสาร์เป็นสีม่วงเสมอ ดูแผนที่ปุ๊บรู้เลยว่าที่ไหนอยู่วันไหน</p>
          </section>
        </aside>
      </div>
      <Toast text={toast} />
    </main>
  );
}

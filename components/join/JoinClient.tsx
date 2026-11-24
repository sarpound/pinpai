"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getName, saveSession, setName } from "@/lib/client/api";
import { Button, Input, Label } from "@/components/ui/Field";
import DayStrip from "@/components/DayStrip";
import { fmtRange } from "@/lib/client/util";

type Preview = { title: string; destination: string | null; start_date: string | null; end_date: string | null; members: number };

export default function JoinClient({ code }: { code: string }) {
  const router = useRouter();
  const [trip, setTrip] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setNm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNm(getName());
    api<Preview>(`/api/join?code=${encodeURIComponent(code)}`).then(setTrip).catch((e) => setErr(e.message));
  }, [code]);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr("ใส่ชื่อเล่นก่อน");
    setBusy(true);
    try {
      const r = await api<{ tripId: string; memberId: string; token: string }>("/api/join", { body: { code, name: name.trim() } });
      setName(name.trim());
      saveSession(r.tripId, { token: r.token, memberId: r.memberId, title: trip?.title });
      router.replace(`/t/${r.tripId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-[460px] flex-col justify-center px-4 py-10">
      <div className="rounded-[28px] bg-surface p-6 shadow-[var(--shadow-2)]">
      <img src="/icon.svg" alt="" className="size-10 rounded-[10px]" />
      {!trip && !err && <div className="mt-6 space-y-3"><div className="skeleton h-8 w-2/3" /><div className="skeleton h-5 w-1/2" /></div>}
      {trip && (
        <>
          <p className="mt-6 text-[14px] text-muted">เพื่อนชวนคุณมาวางแผน</p>
          <h1 className="font-display text-[28px] font-semibold leading-9">{trip.title}</h1>
          <p className="mt-1 text-muted">{fmtRange(trip.start_date, trip.end_date)} · มีเพื่อนอยู่แล้ว {trip.members} คน</p>
          <div className="mt-5"><DayStrip start={trip.start_date} end={trip.end_date} /></div>
          <form onSubmit={go} className="mt-7 space-y-4">
            <div>
              <Label htmlFor="nm">ใส่ชื่อเล่น แล้วเข้าทริปได้เลย</Label>
              <Input id="nm" value={name} onChange={(e) => setNm(e.target.value)} maxLength={40} autoFocus placeholder="เช่น มิ้นท์" />
            </div>
            {err && <p role="alert" className="text-[14px] text-danger">{err}</p>}
            <Button type="submit" disabled={busy} className="w-full">{busy ? "กำลังเข้าทริป…" : "เข้าทริป"}</Button>
            <p className="text-[12px] text-muted">ไม่ต้องสมัครสมาชิก ทริปจะถูกจำไว้ในเครื่องนี้</p>
          </form>
        </>
      )}
      {!trip && err && (
        <div className="mt-6">
          <h1 className="text-[20px] font-semibold">เปิดลิงก์เชิญไม่ได้</h1>
          <p className="mt-1 text-muted">{err}</p>
          <Button variant="secondary" className="mt-5" onClick={() => router.push("/")}>กลับหน้าแรก</Button>
        </div>
      )}
      </div>
    </main>
  );
}

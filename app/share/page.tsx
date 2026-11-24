"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { getSessions, type Session } from "@/lib/client/api";

// PWA share target: TikTok/IG "Share → ปักไป" lands here with ?text=…&url=…
function ShareInner() {
  const sp = useSearchParams();
  const [trips, setTrips] = useState<[string, Session][]>([]);
  const shared = [sp.get("url"), sp.get("text"), sp.get("title")].filter(Boolean).join(" ");
  const link = shared.match(/https?:\/\/\S+/)?.[0] ?? shared;

  useEffect(() => {
    const t = Object.entries(getSessions()).sort((a, b) => b[1].savedAt - a[1].savedAt);
    setTrips(t);
  }, []);

  return (
    <main className="mx-auto max-w-[480px] px-5 py-10">
      <h1 className="text-[20px] font-semibold">เพิ่มคลิปนี้ลงทริปไหน</h1>
      <p className="mt-1 truncate text-[14px] text-muted">{link}</p>
      <Link href={`/?clip=${encodeURIComponent(link)}`} className="mt-5 flex h-12 items-center justify-center rounded-full bg-ink px-6 font-semibold text-white">สร้างทริปใหม่จากคลิปนี้</Link>
      {trips.length === 0 ? (
        <p className="mt-4 text-[14px] text-muted">ยังไม่มีทริปในเครื่องนี้</p>
      ) : (
        <><p className="mt-6 text-[14px] font-semibold">หรือเพิ่มลงทริปที่มีอยู่</p>
        <ul className="mt-2 divide-y divide-line rounded-[16px] border border-line bg-surface">
          {trips.map(([id, s]) => (
            <li key={id}><Link className="block px-4 py-3.5 font-semibold hover:bg-sunken" href={`/t/${id}?import=${encodeURIComponent(link)}`}>{s.title ?? "ทริป"}</Link></li>
          ))}
        </ul></>
      )}
    </main>
  );
}
export default function SharePage() {
  return <Suspense><ShareInner /></Suspense>;
}

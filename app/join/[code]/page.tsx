import type { Metadata } from "next";
import JoinClient from "@/components/join/JoinClient";
import { sql } from "@/lib/db";

// Rich preview when the invite link is pasted into LINE / Messenger
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  try {
    const [t] = await sql`select title, destination, start_date::text, end_date::text from pinpai.trips where invite_code = ${code.toUpperCase().slice(0, 12)}`;
    if (t) {
      const title = `ชวนไป${t.title.replace(/^เที่ยว/, "เที่ยว")} — ปักไป`;
      const description = `เพื่อนชวนมาวางแผนทริป${t.destination ? `ไป${t.destination}` : ""}ด้วยกัน กดลิงก์ ใส่ชื่อเล่น แล้วเข้าทริปได้เลย ไม่ต้องสมัคร`;
      return { title, description, openGraph: { title, description, locale: "th_TH", type: "website", images: [{ url: "/og.png", width: 1200, height: 630 }] }, robots: { index: false } };
    }
  } catch {}
  return { title: "เข้าร่วมทริป — ปักไป", robots: { index: false } };
}

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinClient code={code} />;
}

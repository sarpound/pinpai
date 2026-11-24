import type { Metadata, Viewport } from "next";
import "@fontsource-variable/anuphan";
import "@fontsource/bai-jamjuree/600.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";


export const metadata: Metadata = {
  title: "ปักไป — วางแผนเที่ยวกับเพื่อนบนแผนที่เดียวกัน",
  description: "ปักหมุดที่เที่ยว วางลิงก์ TikTok แล้วได้แผนเที่ยวรายวัน ชวนเพื่อนมาวางแผนและเห็นตำแหน่งกันบนแผนที่",
  manifest: "/manifest.webmanifest",
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192" }], apple: "/apple-touch-icon.png" },
  metadataBase: new URL("https://pinpai-sarpounds-projects.vercel.app"),
  appleWebApp: { capable: true, title: "ปักไป", statusBarStyle: "default" },
  openGraph: { title: "ปักไป — วางแผนเที่ยวกับเพื่อน", description: "วางลิงก์คลิปเที่ยว แล้วได้แผนเที่ยวบนแผนที่", locale: "th_TH", type: "website", images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};
export const viewport: Viewport = { themeColor: "#0B6E4F", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}

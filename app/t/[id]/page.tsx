import TripApp from "@/components/trip/TripApp";

export const metadata = { title: "ทริป — ปักไป" };

export default async function TripPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ import?: string | string[]; plan?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  return <TripApp tripId={id} importUrl={typeof sp.import === "string" ? sp.import.slice(0, 2000) : null} openPlan={sp.plan === "1"} />;
}

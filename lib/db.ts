import postgres from "postgres";

// Dedicated role `pinpai_app` — can only see schema `pinpai` (search_path set on the role).
// Never point this at another role: Marbooking tables live in `public` in the same DB.
const globalForDb = globalThis as unknown as { __pinpaiSql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.__pinpaiSql ??
  postgres(process.env.DATABASE_URL ?? "postgres://invalid", {
    prepare: false, // Supabase transaction pooler
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: "require",
    transform: { undefined: null },
  });

if (process.env.NODE_ENV !== "production") globalForDb.__pinpaiSql = sql;

export async function bumpVersion(tripId: string) {
  await sql`update pinpai.trips set version = version + 1, updated_at = now() where id = ${tripId}`;
}

export async function logActivity(tripId: string, memberId: string | null, text: string) {
  await sql`insert into pinpai.activity (trip_id, member_id, text) values (${tripId}, ${memberId}, ${text.slice(0, 200)})`;
}

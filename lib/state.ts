import { createHash } from "node:crypto";
import { sql } from "./db";

// secret per-trip channel for live positions (only members get it from this payload)
export const liveChannel = (tripId: string) => createHash("sha256").update(`live:${tripId}:${process.env.PINPAI_LIVE_SECRET ?? process.env.DATABASE_URL ?? ""}`).digest("hex").slice(0, 32);

export async function loadTripState(tripId: string, memberId: string) {
  const [trip] = await sql`select id, title, destination, dest_lat, dest_lng, start_date::text, end_date::text, cover_emoji, invite_code, version, updated_at, prefs, guide, plan_job from pinpai.trips where id = ${tripId}`;
  const members = await sql`select id, name, color, role, share_location, share_until, last_seen, travel from pinpai.members where trip_id = ${tripId} order by created_at`;
  const places = await sql`
    select p.id, p.name, p.category, p.lat, p.lng, p.address, p.day_index, p.sort_order, p.start_time, p.duration_min,
           p.notes, p.details, p.source, p.source_url, p.visited, p.added_by, p.created_at,
           coalesce(array_agg(v.member_id) filter (where v.member_id is not null), '{}') as votes
    from pinpai.places p left join pinpai.votes v on v.place_id = p.id
    where p.trip_id = ${tripId}
    group by p.id order by p.day_index nulls last, p.sort_order, p.created_at`;
  const locations = await sql`
    select l.member_id, l.lat, l.lng, l.accuracy, l.updated_at, l.speed, l.heading, l.mode, (l.mode_manual_at is not null) as manual, l.trail from pinpai.locations l
    join pinpai.members m on m.id = l.member_id
    where l.trip_id = ${tripId} and m.share_location and (m.share_until is null or m.share_until > now()) and l.updated_at > now() - interval '12 hours'`;
  const activity = await sql`select a.id, a.member_id, a.text, a.created_at from pinpai.activity a where a.trip_id = ${tripId} order by a.id desc limit 30`;
  const pings = await sql`select id, from_member, to_member, emoji, created_at from pinpai.pings
    where trip_id = ${tripId} and created_at > now() - interval '3 minutes' order by id desc limit 20`;
  const expenses = await sql`select id, paid_by, amount::float8 as amount, category, note, split, created_by, spent_on::text, created_at
    from pinpai.expenses where trip_id = ${tripId} order by created_at desc limit 500`;
  // chat: just the head (unread badge) and any open "where are you?" request addressed to me
  const [chat] = await sql`select coalesce(max(id), 0)::int as last,
      (select row_to_json(r) from (select q.id::int as id, q.member_id, q.created_at from pinpai.messages q
        where q.trip_id = ${tripId} and q.kind = 'locreq' and q.to_member = ${memberId} and q.created_at > now() - interval '15 minutes'
          and not exists (select 1 from pinpai.messages a where a.trip_id = ${tripId} and a.member_id = ${memberId} and a.kind = 'loc' and a.id > q.id)
        order by q.id desc limit 1) r) as locreq
    from pinpai.messages where trip_id = ${tripId}`;
  return { trip, members, places, locations, activity, pings, expenses, me: memberId, live: liveChannel(tripId), chat: { last: chat.last as number, locreq: chat.locreq ?? null } };
}

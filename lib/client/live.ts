"use client";
import { RealtimeClient, type RealtimeChannel } from "@supabase/realtime-js";

// Live positions go peer-to-peer over Supabase Realtime *broadcast* (no database access, nothing stored).
// The channel name is a secret the server hands only to trip members.
const URL = "wss://foacqprvifkydrappakj.supabase.co/realtime/v1";
const KEY = "sb_publishable_z_L_8iZbwLDPbydPHx-YxA_dyCOuA5l";

export type LivePos = { m: string; lat: number; lng: number; h: number | null; s: number | null; t: number };

let client: RealtimeClient | null = null;
export function joinLive(channel: string, onPos: (p: LivePos) => void, onChat?: (m: unknown) => void) {
  client ??= new RealtimeClient(URL, { params: { apikey: KEY, eventsPerSecond: 5 } });
  const ch: RealtimeChannel = client.channel(`pp-${channel}`, { config: { broadcast: { self: false, ack: false } } });
  ch.on("broadcast", { event: "pos" }, (msg) => {
    const p = msg.payload as LivePos;
    if (p && typeof p.lat === "number" && typeof p.lng === "number" && typeof p.m === "string") onPos(p);
  }).on("broadcast", { event: "chat" }, (msg) => onChat?.(msg.payload)).subscribe();
  return {
    send: (p: LivePos) => { ch.send({ type: "broadcast", event: "pos", payload: p }).catch(() => {}); },
    /** tell the others a chat message was just saved (they get it instantly instead of on the next poll) */
    chat: (m: unknown) => { ch.send({ type: "broadcast", event: "chat", payload: m }).catch(() => {}); },
    leave: () => { client?.removeChannel(ch); },
  };
}

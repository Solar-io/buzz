/**
 * Who is in a huddle, without joining it.
 *
 * The web client used to learn the roster only from the audio room's own
 * control frames — which means you had to already be in the call to see who
 * was in the call. The relay does better than that, and has all along: every
 * admission and departure is a relay-SIGNED, PERSISTED event on the PARENT
 * channel (`emit_participant_event` in `crates/buzz-relay/src/audio/handler.rs`,
 * whose comment says exactly why it persists — "so late-joining clients can
 * reconstruct huddle state from historical queries").
 *
 *   48101 participant joined   tags: h = parent channel, p = participant
 *   48102 participant left     content: {ephemeral_channel_id, roster_revision?, admission_id?}
 *   48103 huddle ended         content: {ephemeral_channel_id}
 *
 * So a client already subscribed to a channel can render "3 people in a
 * huddle" with faces on it, live, for free — no audio session, no extra
 * round trip. That is what this module decodes.
 *
 * ORDERING. `roster_revision` is the relay's own monotonic counter for one
 * room, so it — not `created_at` — is the ordering authority: two events one
 * second apart can arrive out of order over pub/sub, and replaying a stale
 * "left" over a fresh "joined" would silently empty a live room. Events
 * without a revision (48103, and any older emission) fall back to timestamps.
 */

import type { SignedNostrEvent } from "../../../shared/lib/nostr-signer.ts";
import {
  HUDDLE_ENDED_KIND,
  HUDDLE_PARTICIPANT_JOINED_KIND,
  HUDDLE_PARTICIPANT_LEFT_KIND,
} from "./huddleRegistry.ts";

export type HuddleLifecycleType = "joined" | "left" | "ended";

export interface HuddleLifecycleEvent {
  type: HuddleLifecycleType;
  /** The huddle's backing (ephemeral) channel. */
  ephemeralId: string;
  /** The channel the huddle hangs off — the `h` tag. */
  parentId: string | null;
  /** The participant this event is about; null on "ended". */
  pubkey: string | null;
  /** The relay's per-room monotonic roster counter, when present. */
  revision: number | null;
  at: number;
}

/** The three kinds this module reads. Handy as a REQ filter. */
export const HUDDLE_LIFECYCLE_KINDS = [
  HUDDLE_PARTICIPANT_JOINED_KIND,
  HUDDLE_PARTICIPANT_LEFT_KIND,
  HUDDLE_ENDED_KIND,
] as const;

function lifecycleType(kind: number): HuddleLifecycleType | null {
  if (kind === HUDDLE_PARTICIPANT_JOINED_KIND) {
    return "joined";
  }
  if (kind === HUDDLE_PARTICIPANT_LEFT_KIND) {
    return "left";
  }
  if (kind === HUDDLE_ENDED_KIND) {
    return "ended";
  }
  return null;
}

export function huddleLifecycleFromEvent(
  event: SignedNostrEvent,
): HuddleLifecycleEvent | null {
  const type = lifecycleType(event.kind);
  if (!type) {
    return null;
  }
  let parsed: { ephemeral_channel_id?: unknown; roster_revision?: unknown };
  try {
    parsed = JSON.parse(event.content) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.ephemeral_channel_id !== "string") {
    return null;
  }
  return {
    type,
    ephemeralId: parsed.ephemeral_channel_id,
    parentId:
      event.tags.find(
        (tag) => tag[0] === "h" && typeof tag[1] === "string",
      )?.[1] ?? null,
    pubkey:
      type === "ended"
        ? null
        : (event.tags.find(
            (tag) => tag[0] === "p" && typeof tag[1] === "string",
          )?.[1] ?? null),
    revision:
      typeof parsed.roster_revision === "number" &&
      Number.isFinite(parsed.roster_revision)
        ? parsed.roster_revision
        : null,
    at: event.created_at,
  };
}

export interface HuddleRoom {
  ephemeralId: string;
  parentId: string | null;
  /** Present participants, in the order they were admitted. */
  participants: string[];
  /** Highest roster revision applied, for out-of-order rejection. */
  revision: number | null;
  /** created_at of the newest applied event. */
  updatedAt: number;
  /** A 48103 landed — the huddle is over, whoever is still listed. */
  ended: boolean;
}

export type HuddleRoomMap = ReadonlyMap<string, HuddleRoom>;

/**
 * Fold one lifecycle event into the room map.
 *
 * Returns the SAME reference when nothing changed — a duplicate delivery, a
 * stale revision, a leave for someone who is not listed — so a React state
 * setter can be handed this directly without churning renders.
 */
export function applyHuddleLifecycle(
  rooms: HuddleRoomMap,
  event: HuddleLifecycleEvent,
): HuddleRoomMap {
  const existing = rooms.get(event.ephemeralId);
  if (existing) {
    // Revision beats timestamp; when neither side has one, fall back to it.
    if (
      event.revision !== null &&
      existing.revision !== null &&
      event.revision <= existing.revision
    ) {
      return rooms;
    }
    if (
      (event.revision === null || existing.revision === null) &&
      event.at < existing.updatedAt
    ) {
      return rooms;
    }
  }
  const participants = existing ? [...existing.participants] : [];
  let ended = existing?.ended ?? false;

  if (event.type === "ended") {
    ended = true;
    participants.length = 0;
  } else if (event.pubkey) {
    const at = participants.indexOf(event.pubkey);
    if (event.type === "joined") {
      if (at === -1) {
        participants.push(event.pubkey);
      }
      // A join re-opens a room the relay had ended: the backing channel can
      // be reused before its TTL expires, and a stale `ended` would hide a
      // live call.
      ended = false;
    } else if (at !== -1) {
      participants.splice(at, 1);
    }
  }

  if (
    existing &&
    existing.ended === ended &&
    existing.participants.length === participants.length &&
    existing.participants.every((pubkey, i) => pubkey === participants[i])
  ) {
    // Nothing observable changed. Advancing the revision alone is not worth
    // a re-render, and keeping the older one is safe: a later event with a
    // higher revision still applies.
    return rooms;
  }

  const next = new Map(rooms);
  next.set(event.ephemeralId, {
    ephemeralId: event.ephemeralId,
    parentId: event.parentId ?? existing?.parentId ?? null,
    participants,
    revision: event.revision ?? existing?.revision ?? null,
    updatedAt: Math.max(event.at, existing?.updatedAt ?? 0),
    ended,
  });
  return next;
}

/** Rooms hanging off one parent channel that still have somebody in them. */
export function liveHuddlesFor(
  rooms: HuddleRoomMap,
  parentChannelId: string,
): HuddleRoom[] {
  return [...rooms.values()]
    .filter(
      (room) =>
        room.parentId === parentChannelId &&
        !room.ended &&
        room.participants.length > 0,
    )
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/**
 * How long a huddle stays joinable after it started.
 *
 * The desktop's `HUDDLE_JOINABLE_WINDOW_SECONDS`, and the same number the
 * relay grants the backing channel (`expected_huddle_backing_ttl` → 3600).
 * Past it the channel is archived server-side, so offering "Join" is a
 * promise the relay will refuse.
 */
export const HUDDLE_JOINABLE_WINDOW_SECONDS = 60 * 60;

export function isHuddleStale(
  startedAtSeconds: number,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  return nowSeconds - startedAtSeconds > HUDDLE_JOINABLE_WINDOW_SECONDS;
}

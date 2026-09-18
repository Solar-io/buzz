/**
 * Huddle lifecycle registry: kind 48100 links a parent channel to its
 * ephemeral backing channel (content {ephemeral_channel_id}); kind 48102
 * ends it. Joiners must present the linked parent id to the audio room —
 * the relay verifies the link against a creator-signed 48100.
 */

import type { SignedNostrEvent } from "../../../shared/lib/nostr-signer.ts";

export const HUDDLE_STARTED_KIND = 48100;
/** 48101 — the relay signs one per participant admitted to the audio room. */
export const HUDDLE_PARTICIPANT_JOINED_KIND = 48101;
/** 48102 — the relay signs one per participant leaving the audio room. */
export const HUDDLE_PARTICIPANT_LEFT_KIND = 48102;
/**
 * 48103 — the huddle itself ended.
 *
 * This was 48102 here, which is PARTICIPANT_LEFT (`KIND_HUDDLE_ENDED = 48103`
 * in `crates/buzz-core/src/kind.rs`, and the relay's own auto-end emits
 * `Kind::Custom(48103)` in `audio/handler.rs`). The consequence was not
 * cosmetic: `useHuddleLinks` treated the FIRST person leaving as the whole
 * huddle ending and dropped the link, while a genuinely ended huddle was
 * never retired at all — so the join affordance both vanished early and
 * lingered forever, depending on which event arrived.
 */
export const HUDDLE_ENDED_KIND = 48103;
/** The relay's expected ephemeral backing-channel ttl (no override set). */
export const HUDDLE_BACKING_TTL_SECONDS = 3600;

export interface HuddleLink {
  ephemeralId: string;
  parentId: string;
  createdBy: string;
  at: number;
}

export function huddleLinkFromEvent(
  event: SignedNostrEvent,
): HuddleLink | null {
  if (event.kind !== HUDDLE_STARTED_KIND) {
    return null;
  }
  const parentId = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!parentId) {
    return null;
  }
  let ephemeralId: string | undefined;
  try {
    const parsed = JSON.parse(event.content) as {
      ephemeral_channel_id?: unknown;
    };
    if (typeof parsed.ephemeral_channel_id === "string") {
      ephemeralId = parsed.ephemeral_channel_id;
    }
  } catch {
    // Malformed content: no link.
  }
  if (!ephemeralId) {
    return null;
  }
  return {
    ephemeralId,
    parentId,
    createdBy: event.pubkey,
    at: event.created_at,
  };
}

export function huddleEndedTarget(event: SignedNostrEvent): string | null {
  if (event.kind !== HUDDLE_ENDED_KIND) {
    return null;
  }
  let ephemeralId: string | null = null;
  try {
    const parsed = JSON.parse(event.content) as {
      ephemeral_channel_id?: unknown;
    };
    if (typeof parsed.ephemeral_channel_id === "string") {
      ephemeralId = parsed.ephemeral_channel_id;
    }
  } catch {
    // ignore
  }
  return ephemeralId;
}

/**
 * The full registry state the live event feed folds into: the joinable
 * links, plus the ephemeral ids a kind-48103 has retired.
 *
 * The ENDED set is what makes cold load correct, and it exists because the
 * relay's historical replay is NEWEST FIRST (`ORDER BY created_at DESC` in
 * `crates/buzz-db/src/event.rs`). A replayed huddle therefore delivers its
 * 48103 before its 48100, and a reducer that only deletes links it already
 * has ("ignore an end for an unknown id") resurrects every auto-ended
 * huddle as live on every page load — the exact V1b defect: an enabled
 * Join on a room the relay had already ended, whose click then dead-ends
 * against the relay's "channel is archived" refusal. Recording the end
 * FIRST and suppressing the later start makes the fold order-insensitive:
 * whichever order the replay (or live traffic) delivers, a ended huddle
 * stays ended.
 */
export interface HuddleRegistryState {
  /** Live links: ephemeral channel id → its kind-48100 link. */
  links: Map<string, HuddleLink>;
  /** Ephemeral channel ids a kind-48103 has retired (replay or live). */
  ended: Set<string>;
}

export function emptyHuddleRegistryState(): HuddleRegistryState {
  return { links: new Map(), ended: new Set() };
}

/**
 * Fold one registry event into the state. Order-insensitive — see the
 * struct docs. Returns the SAME object when the event changes nothing, so
 * a React setState consumer can bail out of a re-render by identity.
 */
export function applyRegistryEvent(
  state: HuddleRegistryState,
  event: SignedNostrEvent,
): HuddleRegistryState {
  const link = huddleLinkFromEvent(event);
  if (link) {
    if (
      state.ended.has(link.ephemeralId) ||
      state.links.has(link.ephemeralId)
    ) {
      // Already retired (the replay's end arrived first), or a duplicate
      // delivery of a link we hold. Either way the state stands.
      return state;
    }
    const next = { links: new Map(state.links), ended: new Set(state.ended) };
    next.links.set(link.ephemeralId, link);
    return next;
  }
  const ended = huddleEndedTarget(event);
  if (ended) {
    if (state.ended.has(ended) && !state.links.has(ended)) {
      return state;
    }
    const next = { links: new Map(state.links), ended: new Set(state.ended) };
    next.ended.add(ended);
    next.links.delete(ended);
    return next;
  }
  return state;
}

/**
 * Explicit `#h` values the relay accepts in one REQ.
 * `MAX_EXPLICIT_CHANNEL_VALUES` in `crates/buzz-relay/src/handlers/req.rs`.
 */
export const MAX_CHANNELS_PER_REQ = 128;

/**
 * REQ filters for the huddle registry, one per chunk of parent channels.
 *
 * `#h` is load-bearing, not an optimisation. The relay resolves subscription
 * scope per REQ, not per filter: a filter carrying no `#h` registers the whole
 * subscription as global, and a channel-carrying event is then matched only
 * against the channel-keyed indexes. Without it the REQ gets the historical
 * replay and never another event — a huddle starting after page load never
 * appears, and one ending never clears.
 *
 * Past the cap the relay answers CLOSED rather than truncating, so an
 * unchunked REQ loses every huddle, not merely the excess.
 */
export function huddleRegistryFilters(
  channelIds: readonly string[],
): { kinds: number[]; "#h": string[]; limit: number }[] {
  const filters: { kinds: number[]; "#h": string[]; limit: number }[] = [];
  for (let i = 0; i < channelIds.length; i += MAX_CHANNELS_PER_REQ) {
    filters.push({
      kinds: [HUDDLE_STARTED_KIND, HUDDLE_ENDED_KIND],
      "#h": channelIds.slice(i, i + MAX_CHANNELS_PER_REQ),
      limit: 200,
    });
  }
  return filters;
}

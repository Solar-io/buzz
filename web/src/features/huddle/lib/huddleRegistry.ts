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

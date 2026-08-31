/**
 * Huddle lifecycle registry: kind 48100 links a parent channel to its
 * ephemeral backing channel (content {ephemeral_channel_id}); kind 48102
 * ends it. Joiners must present the linked parent id to the audio room —
 * the relay verifies the link against a creator-signed 48100.
 */

import type { SignedNostrEvent } from "../../../shared/lib/nostr-signer.ts";

export const HUDDLE_STARTED_KIND = 48100;
export const HUDDLE_ENDED_KIND = 48102;
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

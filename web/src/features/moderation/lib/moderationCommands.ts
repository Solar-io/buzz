/**
 * Unsigned event templates for the moderation commands a message row can fire.
 *
 * Tag vocabulary is pinned by the relay and quoted here so a drift shows up as
 * a diff rather than a runtime `invalid:`:
 *
 * - 9040 ban — `["p", <hex>]` required; optional `["expiration", <unix secs>]`
 *   (absent ⇒ permanent) and `["reason", <text>]`.
 * - 9041 unban — `["p", <hex>]`.
 * - 9042 timeout — `["p", <hex>]` **and** a required `["expiration", <unix secs>]`;
 *   optional `["reason", <text>]`.
 * - 9043 untimeout — `["p", <hex>]`.
 *   (all four: `handlers/moderation_commands.rs` module docs)
 * - 9001 kick — `["h", <channel uuid>]` + `["p", <hex>]`
 *   (`side_effects.rs::validate_admin_event` arm 9001).
 * - 9005 remove message — `["h", <channel uuid>]` + exactly one `["e", <hex>]`;
 *   optional `["public_reason", <text>]` / `["reason_code", <code>]`, which the
 *   relay copies into the kind-40099 tombstone the timeline already renders
 *   (`handle_delete_event_side_effect`). Ingest rejects a deletion carrying
 *   anything other than exactly one e/a target.
 *
 * **9040–9043 carry no `h` tag.** They are community-global direct commands;
 * `is_global_only_kind` rejects a stray `h` as channel-scoping a global
 * command. 9001/9005 are the opposite — they are channel-scoped and the `h`
 * tag is how the relay resolves which channel's roles to check.
 *
 * Import-free by design so the node test runner can load it directly.
 */

import type { EventTemplate } from "./reportEvent.ts";
import { normalizeHex32 } from "./reportEvent.ts";

/** Community moderation commands — `is_moderation_command_kind`, 9040–9043. */
export const KIND_MODERATION_BAN = 9040;
export const KIND_MODERATION_UNBAN = 9041;
export const KIND_MODERATION_TIMEOUT = 9042;
export const KIND_MODERATION_UNTIMEOUT = 9043;
/** NIP-29 channel-scoped admin commands. */
export const KIND_NIP29_REMOVE_USER = 9001;
export const KIND_NIP29_DELETE_EVENT = 9005;

function optionalText(tags: string[][], name: string, value?: string): void {
  const trimmed = value?.trim();
  if (trimmed) {
    tags.push([name, trimmed]);
  }
}

/**
 * Validate a channel id before it becomes an `h` tag. The relay parses it as a
 * UUID and rejects the event otherwise; catching it here keeps the failure
 * legible instead of arriving as `invalid: missing or invalid h tag`.
 */
function normalizeChannelId(channelId: string): string {
  const trimmed = channelId.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    throw new Error("Malformed channel id: expected a UUID.");
  }
  return trimmed.toLowerCase();
}

/**
 * Ban a member from the community (kind:9040). Omit `expiresAt` for a
 * permanent ban — the relay reads an absent `expiration` tag as permanent.
 */
export function buildBanEvent(input: {
  pubkey: string;
  expiresAt?: number;
  reason?: string;
}): EventTemplate {
  const tags: string[][] = [
    ["p", normalizeHex32(input.pubkey, "target pubkey")],
  ];
  if (input.expiresAt != null) {
    tags.push(["expiration", String(Math.floor(input.expiresAt))]);
  }
  optionalText(tags, "reason", input.reason);
  return { kind: KIND_MODERATION_BAN, tags, content: "" };
}

/** Lift a community ban (kind:9041). */
export function buildUnbanEvent(pubkey: string): EventTemplate {
  return {
    kind: KIND_MODERATION_UNBAN,
    tags: [["p", normalizeHex32(pubkey, "target pubkey")]],
    content: "",
  };
}

/**
 * Time out a member (kind:9042). `expiresAt` is epoch **seconds** and is
 * required by the relay — a timeout with no expiry has no lift path.
 */
export function buildTimeoutEvent(input: {
  pubkey: string;
  expiresAt: number;
  reason?: string;
}): EventTemplate {
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error("A timeout needs a positive expiry in epoch seconds.");
  }
  const tags: string[][] = [
    ["p", normalizeHex32(input.pubkey, "target pubkey")],
    ["expiration", String(Math.floor(input.expiresAt))],
  ];
  optionalText(tags, "reason", input.reason);
  return { kind: KIND_MODERATION_TIMEOUT, tags, content: "" };
}

/** Clear a timeout early (kind:9043). */
export function buildUntimeoutEvent(pubkey: string): EventTemplate {
  return {
    kind: KIND_MODERATION_UNTIMEOUT,
    tags: [["p", normalizeHex32(pubkey, "target pubkey")]],
    content: "",
  };
}

/** Remove the author from this channel (kind:9001). */
export function buildKickEvent(input: {
  channelId: string;
  pubkey: string;
}): EventTemplate {
  return {
    kind: KIND_NIP29_REMOVE_USER,
    tags: [
      ["h", normalizeChannelId(input.channelId)],
      ["p", normalizeHex32(input.pubkey, "target pubkey")],
    ],
    content: "",
  };
}

/**
 * Moderator removal of one message (kind:9005).
 *
 * A `publicReason` is room-facing: the relay copies it verbatim into the
 * kind-40099 tombstone every client renders, so it must be safe for the whole
 * channel to read. It also flips the relay off its self-delete fast path
 * (`author_delete_can_use_self_delete_path`), which is correct — this is an
 * audited moderator action even in the degenerate case where the moderator is
 * also the author.
 */
export function buildRemoveMessageEvent(input: {
  channelId: string;
  targetEventId: string;
  publicReason?: string;
  reasonCode?: string;
}): EventTemplate {
  const tags: string[][] = [
    ["h", normalizeChannelId(input.channelId)],
    ["e", normalizeHex32(input.targetEventId, "target event id")],
  ];
  optionalText(tags, "public_reason", input.publicReason);
  optionalText(tags, "reason_code", input.reasonCode);
  return { kind: KIND_NIP29_DELETE_EVENT, tags, content: "" };
}

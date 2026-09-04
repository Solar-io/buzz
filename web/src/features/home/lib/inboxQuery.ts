/**
 * Relay request shapes for the home inbox.
 *
 * ## How the inbox is populated (and why it is not a client-side scan)
 *
 * The relay already indexes "events addressed to me": a global filter
 * `{kinds:[…], "#p":[self]}` is answered from `global_p_kind_index` and
 * returns stored mentions across every channel in ONE request. That is the
 * same affordance the desktop client uses — its `get_feed` Tauri command
 * (`desktop/src-tauri/src/commands/messages.rs`) issues exactly this filter.
 * So the web inbox does not walk the channel list asking each channel for its
 * messages; the fan-in happens server-side, on an index.
 *
 * DMs are the exception, and it is a property of the wire format rather than a
 * gap in the relay: a DM message is an ordinary kind:9 carrying `h` for the DM
 * channel and NO `p` tag (`p` tags are written only for explicit @-mentions —
 * see `sendChannelMessage` in `features/channels/hooks.ts`). A `#p` query
 * therefore cannot see them. DMs are fetched by `#h` over the viewer's own DM
 * channels, which the shell already knows from the kind:39000 list.
 *
 * ## Two rules this module exists to encode
 *
 * 1. **A `#p`-only subscription is never a live fan-out candidate.**
 *    `SubscriptionRegistry::fan_out_scoped`
 *    (`crates/buzz-relay/src/subscription.rs`) matches an event that carries a
 *    channel against the channel-keyed indexes ONLY; the global `(kind, #p)`
 *    index is consulted for channel-less events. A kind:9 always carries `h`,
 *    so the global mention filter returns history and then goes silent
 *    forever. Liveness needs a second, `#h`-scoped request.
 *
 * 2. **Never mix an `#h`-less filter into a request that has `#h` filters.**
 *    `extract_channel_ids_from_filters` (`handlers/req.rs`) bails to `None` —
 *    i.e. the WHOLE subscription is registered as Global — the moment any one
 *    filter in the REQ lacks `#h`. Bundling the mention-history filter with
 *    the DM filter to save a round trip would therefore silently un-live the
 *    DM half. {@link inboxRequests} keeps them in separate requests, and
 *    `inboxQuery.test.mjs` pins that invariant.
 *
 * ## Ceilings
 *
 * - `MAX_EXPLICIT_CHANNEL_VALUES` (128) `#h` values per REQ, relay-enforced:
 *   over it the relay answers `CLOSED … "restricted: too many explicit
 *   channels"`. Channel ids are chunked here so a large account degrades into
 *   more requests rather than a refused one.
 * - `max_filters` = 10 per REQ (relay NIP-11).
 * - `max_limit` = 1000 per filter (relay NIP-11).
 */

import type { NostrFilter } from "@/shared/lib/nostr-client";

/**
 * Kinds that can address the viewer directly: chat messages (9) and the
 * broadcast/announcement kind (40002). Deliberately narrower than the channel
 * timeline's kind list — a system row or a reaction is not inbox material.
 */
export const INBOX_MENTION_KINDS = [9, 40002] as const;

/** Chat message kind — the only kind a DM carries. */
export const INBOX_DM_KIND = 9;

/**
 * Relay cap on the total number of `#h` values across one REQ
 * (`MAX_EXPLICIT_CHANNEL_VALUES`, `crates/buzz-relay/src/handlers/req.rs`).
 * Exceeding it closes the subscription outright.
 */
export const MAX_CHANNELS_PER_REQUEST = 128;

/** Relay NIP-11 `max_filters`. */
export const MAX_FILTERS_PER_REQUEST = 10;

/** How many stored mentions to pull on load. */
export const MENTION_HISTORY_LIMIT = 100;

/** How many stored DM messages to pull on load, across all DM channels. */
export const DM_HISTORY_LIMIT = 200;

/** One REQ: a list of filters that are OR'd by the relay. */
export type InboxRequest = NostrFilter[];

/** Split channel ids into groups the relay will accept in a single REQ. */
export function chunkChannelIds(
  channelIds: readonly string[],
  size = MAX_CHANNELS_PER_REQUEST,
): string[][] {
  const unique = Array.from(new Set(channelIds)).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    chunks.push(unique.slice(i, i + size));
  }
  return chunks;
}

/**
 * Stored mentions across every channel, in one global request.
 *
 * No `#h`, so this is history only — see rule 1 above. It must travel in a
 * request of its own.
 */
export function mentionHistoryRequest(
  selfPubkey: string,
  limit = MENTION_HISTORY_LIMIT,
): InboxRequest {
  return [
    {
      kinds: [...INBOX_MENTION_KINDS],
      "#p": [selfPubkey],
      limit,
    },
  ];
}

/**
 * Live mentions. `#h` puts the subscription in the channel index so the relay
 * actually fans out to it; `#p` keeps the relay doing the mention filtering.
 * `since` makes it live-only — history is the other request's job.
 */
export function mentionLiveRequests(
  channelIds: readonly string[],
  selfPubkey: string,
  since: number,
): InboxRequest[] {
  return chunkChannelIds(channelIds).map((chunk) => [
    {
      kinds: [...INBOX_MENTION_KINDS],
      "#h": chunk,
      "#p": [selfPubkey],
      since,
    },
  ]);
}

/**
 * DM history AND liveness in one request per chunk: the filter carries `#h`,
 * so it is registered in the channel index and keeps delivering after EOSE.
 * The shared `limit` is intentional — an inbox wants the newest messages
 * overall, not an even sample per conversation.
 */
export function dmRequests(
  dmChannelIds: readonly string[],
  limit = DM_HISTORY_LIMIT,
): InboxRequest[] {
  return chunkChannelIds(dmChannelIds).map((chunk) => [
    {
      kinds: [INBOX_DM_KIND],
      "#h": chunk,
      limit,
    },
  ]);
}

/**
 * Every relay request the inbox needs, as separate REQs.
 *
 * Separate is load-bearing, not tidiness: see rule 2 in the module comment.
 */
export function inboxRequests(options: {
  selfPubkey: string | null;
  /** Channels to watch for live mentions (the viewer's non-archived list). */
  channelIds: readonly string[];
  /** DM channels the viewer is in. */
  dmChannelIds: readonly string[];
  /** Live cutoff, unix seconds. */
  since: number;
  mentionLimit?: number;
  dmLimit?: number;
}): InboxRequest[] {
  const { selfPubkey, channelIds, dmChannelIds, since } = options;
  if (!selfPubkey) {
    return [];
  }
  return [
    mentionHistoryRequest(selfPubkey, options.mentionLimit),
    ...mentionLiveRequests(channelIds, selfPubkey, since),
    ...dmRequests(dmChannelIds, options.dmLimit),
  ];
}

/**
 * True when a request would be registered as channel-scoped by the relay —
 * i.e. every filter in it carries `#h`. A request with a mix is Global, and a
 * Global request never receives live channel events.
 */
export function isChannelScopedRequest(request: InboxRequest): boolean {
  return (
    request.length > 0 &&
    request.every((filter) => (filter["#h"]?.length ?? 0) > 0)
  );
}

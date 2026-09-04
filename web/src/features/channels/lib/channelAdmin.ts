/**
 * Pure helpers for channel admin events (rename/delete). Import-free so the
 * node test runner can load this file directly.
 */

/**
 * Canonical channel name — mirrors buzz-core's canonical_channel_name:
 * strip a leading `#` (and any whitespace before it), trim the tail.
 */
export function canonicalChannelName(name: string): string {
  return name.replace(/^[#\s]+/, "").trimEnd();
}

/** Tags for a kind-9002 rename (buzz-sdk build_update_channel name-only). */
export function renameChannelTags(channelId: string, name: string): string[][] {
  return [
    ["h", channelId],
    ["name", canonicalChannelName(name)],
  ];
}

/** Tags for a kind-9008 delete-group (buzz-sdk build_delete_channel). */
export function deleteChannelTags(channelId: string): string[][] {
  return [["h", channelId]];
}

/** NIP-29 join request. The relay accepts it only for OPEN channels. */
export const JOIN_CHANNEL_KIND = 9021;
/** NIP-29 leave request. */
export const LEAVE_CHANNEL_KIND = 9022;

/**
 * Tags for a kind-9021 join request.
 *
 * The `h` tag is not optional decoration here: the relay rejects a join
 * without one outright ("invalid: join request must include an h tag" —
 * `handlers/ingest.rs`), and it is also what scopes the resulting membership
 * change. A private channel refuses the join regardless; only `public`
 * channels can be joined this way, which is why the header offers the button
 * on open channels only.
 */
export function joinChannelTags(channelId: string): string[][] {
  return [["h", channelId]];
}

/** Tags for a kind-9022 leave request. */
export function leaveChannelTags(channelId: string): string[][] {
  return [["h", channelId]];
}

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

/** What a settled delete publish means for client state. */
export type DeleteChannelVerdict =
  | { readonly outcome: "deleted"; readonly channelId: string }
  | { readonly outcome: "refused"; readonly message: string };

/**
 * Classify a settled kind-9008 publish for the UI's delete flow.
 *
 * The success verdict carries the channel id so the caller evicts client
 * state (sidebar list, seed, timeline cache, per-channel prefs) ONLY on the
 * relay-confirmed path — never optimistically before the ack. The failure
 * verdict carries the relay's own message verbatim ("only owner can delete
 * group", …) so a refused delete surfaces instead of silently no-oping.
 */
export function deleteChannelVerdict(
  channelId: string,
  publish: { ok: boolean; message: string },
): DeleteChannelVerdict {
  return publish.ok
    ? { outcome: "deleted", channelId }
    : { outcome: "refused", message: publish.message };
}

/**
 * Sidebar/channel list minus one channel — the eviction core for a deleted
 * channel. Pure, so the list eviction is testable without React.
 */
export function withoutChannel<T extends { id: string }>(
  channels: readonly T[],
  channelId: string,
): T[] {
  return channels.filter((channel) => channel.id !== channelId);
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

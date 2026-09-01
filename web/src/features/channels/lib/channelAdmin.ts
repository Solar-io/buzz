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

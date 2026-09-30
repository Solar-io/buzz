import { isWakeForOthers } from "../../channels/lib/wakeMessage.ts";

/**
 * Whether one kind-9 in a DM counts toward that DM row's unread badge.
 *
 * The viewer's own messages never count. Neither does a scheduled wake
 * addressed to another member of the DM (see `isWakeForOthers`): it is
 * machinery the viewer is a bystander to. A wake that p-tags the viewer
 * counts like any other message.
 */
export function countsTowardDmUnread(
  event: { kind: number; pubkey: string; tags: string[][] },
  selfPubkey: string | null,
): boolean {
  if (event.pubkey === selfPubkey) {
    return false;
  }
  return !isWakeForOthers(event, selfPubkey);
}

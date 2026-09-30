/**
 * Which thread the right-hand pane shows, and what survives navigation
 * (Sam, 2026-09-29: "if I open the threaded view it should stay open even as
 * I change views").
 *
 * A thread is named by its channel AND its root. Before this, the route kept
 * a bare root id, cleared it on every sidebar click, and resolved it only
 * against the OPEN channel's buffer — so any switch closed the pane twice
 * over. Now the pane keeps showing the thread the viewer opened, beside
 * whatever conversation or view they move to, until they close it (✕, Esc
 * in the pane's composer, or the Replies toggle).
 *
 * Why the SAME thread rather than "the new channel's threads": the pane is a
 * single thread (root + replies + a composer answering that root) — there is
 * no per-channel thread list to fall back to, and keeping the conversation
 * the viewer deliberately opened is the one reading that stays meaningful
 * after a switch. Opening a different thread replaces it, as before.
 *
 * The exception is the OVERLAY form (below `lg`, or the Focus thread
 * layout): there the pane is a full-screen sheet over the conversation, so
 * "staying open" would hide the channel the viewer just picked. Overlay
 * threads still close on navigation, exactly as they always did.
 */

import { dmDisplayName, type NameLikeProfile } from "../../dms/lib/dmNaming.ts";

export interface OpenThread {
  /** Channel (or DM) the thread lives in. */
  channelId: string;
  /** The thread's root message id. */
  rootId: string;
}

/**
 * The thread state after the open conversation becomes `selectedId`
 * (undefined for a non-conversation view: Inbox, Reminders, …).
 */
export function threadAfterNavigation(
  open: OpenThread | null,
  { selectedId, docked }: { selectedId: string | undefined; docked: boolean },
): OpenThread | null {
  if (open === null) return null;
  if (docked) return open;
  return open.channelId === selectedId ? open : null;
}

/**
 * Point the pane at `rootId` (timeline "open thread", a reply permalink, the
 * Replies toggle restoring its last root) — or close it with null. A root id
 * alone is resolved against the conversation it was set from; re-setting the
 * root already open keeps its channel, so the toggle can re-show a thread
 * that lives in another channel.
 */
export function retargetThread(
  open: OpenThread | null,
  rootId: string | null,
  currentChannelId: string | undefined,
): OpenThread | null {
  if (rootId === null) return null;
  if (open !== null && open.rootId === rootId) return open;
  if (!currentChannelId) return open;
  return { channelId: currentChannelId, rootId };
}

/**
 * Where the pane's content comes from: nothing open, the open conversation
 * (its buffer, members and send are already live in the route), or another
 * channel (the pane opens its own feed for it).
 */
export function threadPaneSource(
  open: OpenThread | null,
  currentChannelId: string | undefined,
): "none" | "current" | "other" {
  if (open === null) return "none";
  return open.channelId === currentChannelId ? "current" : "other";
}

/**
 * The kept-open pane's "in …" label for the thread's channel: `#name` for a
 * channel or forum, the participants' names for a DM (the relay names every
 * DM channel "DM", so its own name says nothing).
 */
export function threadOriginLabel(
  channel: { type: string; name: string; participantPubkeys: string[] },
  selfPubkey: string | null,
  profiles: Map<string, NameLikeProfile>,
): string {
  return channel.type === "dm"
    ? dmDisplayName(channel.participantPubkeys, selfPubkey ?? "", profiles)
    : `#${channel.name}`;
}

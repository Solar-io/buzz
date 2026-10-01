/**
 * The channel canvas (kind 40100): one markdown document per conversation,
 * written by `buzz canvas set` and the desktop's channel sheet, and the
 * first document in the right pane's Canvas tab when it has content.
 *
 * Wire shape (buzz-sdk `build_set_canvas`): a REGULAR, channel-scoped event
 * — `["h", <channel uuid>]` and the markdown as `content`. Every set appends
 * a new event; the canvas is the newest one (desktop and the CLI both read
 * `{"kinds":[40100],"#h":[id],"limit":1}`). Setting an empty content is how
 * a canvas is cleared.
 *
 * Import-free apart from types, so `node --test` loads it.
 */

import type { NostrFilter } from "@/shared/lib/nostr-client";
import { CHANNEL_CANVAS_KEY } from "@/features/shelf/lib/fileTabs.ts";

export const KIND_CANVAS = 40100;

export interface ChannelCanvasDoc {
  eventId: string;
  channelId: string;
  /** Markdown, as set. */
  content: string;
  authorPubkey: string;
  /** Unix seconds of the set. */
  updatedAt: number;
}

/** Where the canvas query stands for the conversation on screen. */
export type ChannelCanvasPhase = "idle" | "loading" | "ready";

/** History (the newest set) and live sets — `#h` is what makes it live. */
export function channelCanvasFilter(channelId: string): NostrFilter {
  return { kinds: [KIND_CANVAS], "#h": [channelId], limit: 1 };
}

interface CanvasEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
}

/** A canvas event for THIS channel, or null for anything else. */
export function canvasFromEvent(
  event: CanvasEventLike,
  channelId: string,
): ChannelCanvasDoc | null {
  if (event.kind !== KIND_CANVAS || typeof event.content !== "string") {
    return null;
  }
  const scoped = event.tags.some(
    (tag) => tag[0] === "h" && tag[1] === channelId,
  );
  if (!scoped) {
    return null;
  }
  return {
    eventId: event.id,
    channelId,
    content: event.content,
    authorPubkey: event.pubkey,
    updatedAt: event.created_at,
  };
}

/** The newer of two sets; a tie on the second goes to the larger id. */
export function newerCanvas(
  current: ChannelCanvasDoc | null,
  next: ChannelCanvasDoc | null,
): ChannelCanvasDoc | null {
  if (next === null) {
    return current;
  }
  if (current === null) {
    return next;
  }
  if (next.updatedAt !== current.updatedAt) {
    return next.updatedAt > current.updatedAt ? next : current;
  }
  return next.eventId > current.eventId ? next : current;
}

/** A canvas that says something — a cleared (blank) canvas is no document. */
export function hasCanvasContent(doc: ChannelCanvasDoc | null): boolean {
  return doc !== null && doc.content.trim() !== "";
}

/**
 * Does Canvas list the channel canvas? When it has content, yes. While the
 * query is still out, only if it is the document the viewer is on — so
 * switching channels does not flash a "Channel canvas" tab into every
 * conversation that has none, and does not drop the viewer off the canvas
 * they were reading while the next one loads.
 */
export function channelCanvasListed(
  phase: ChannelCanvasPhase,
  doc: ChannelCanvasDoc | null,
  selected: string | null,
): boolean {
  if (hasCanvasContent(doc)) {
    return true;
  }
  return phase === "loading" && selected === CHANNEL_CANVAS_KEY;
}

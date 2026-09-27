/**
 * `reduceStageSession` — the pure reducer from (open event, candidate
 * events) to one Stage session (design §4.3 + §15.1).
 *
 * The manifest is a PALETTE (frames available), not the show length. The
 * session is an ordered SEQUENCE OF SHOWINGS: one per valid part event,
 * sorted by `created_at`, then `seq` when both carry one (the CLI's
 * per-session posting counter), then the event id. A frame may be shown
 * any number of times, in any order — there is no dedupe by `i` and no
 * implicit end on the last index. A session ends only on a valid `close`.
 *
 * A part (or close) belongs to session S only when ALL of §4.3 hold:
 *  1. its stage tag parses with `s == S`;
 *  2. `event.pubkey == open.pubkey` — the anti-injection rule (U4);
 *  3. `event.h == open.h`;
 *  4. `0 <= i < palette.length`;
 *  5. `open.created_at <= event.created_at <= open.created_at + 24 h`.
 * Anything else is ignored by Stage (it still renders in the timeline).
 */

import {
  textWithoutAttachments,
  type SpeechEventLike,
} from "../../huddle/lib/huddleAgentSpeech.ts";
import { speakableText } from "./speakableText.ts";
import type { NostrFilter } from "../../../shared/lib/nostr-client.ts";
import {
  parseStageTag,
  type StagePaletteEntry,
  type StageTag,
} from "./stageTag.ts";

/** Rule 5's window: parts must land within 24 h of the open. */
export const STAGE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * The minimal event shape the reducer reads — a signed Nostr event
 * satisfies it, and so does the adapter over a timeline message.
 */
export interface StageEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}

export interface StageShowing {
  /** The part event's id — also the speak-once key (§15.2). */
  eventId: string;
  /** Palette index this showing displays. */
  i: number;
  /** Absent on the wire = true; false = show on arrival (§15.2). */
  hold: boolean;
  /** The paragraph as markdown, image line removed (chat caption). */
  text: string;
  /** What the voice says: `text` with markdown punctuation stripped. */
  speakText: string;
  /** The part's OWN image (authoritative), falling back to the palette. */
  imageUrl: string;
  createdAt: number;
  /** The part tag's optional posting counter (same-second tiebreak). */
  seq?: number;
}

export interface StageSession {
  openId: string;
  author: string;
  channelId: string;
  title: string;
  voice: boolean;
  openedAt: number;
  palette: StagePaletteEntry[];
  showings: StageShowing[];
  closed: boolean;
}

function hTag(event: StageEventLike): string | null {
  const value = event.tags.find((tag) => tag[0] === "h")?.[1];
  return typeof value === "string" ? value : null;
}

/** First `imeta` url on the event — the image the part itself carries. */
function ownImageUrl(event: StageEventLike): string | null {
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    for (const field of tag.slice(1)) {
      if (field.startsWith("url ")) return field.slice(4);
    }
  }
  const markdown = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(event.content);
  return markdown ? markdown[1] : null;
}

/** The open tag of an event, or null when it is not a valid Stage open. */
export function stageOpenOf(
  event: StageEventLike,
): Extract<StageTag, { op: "open" }> | null {
  if (event.kind !== 9) return null;
  const tag = parseStageTag(event.tags);
  return tag?.op === "open" ? tag : null;
}

function withinWindow(open: StageEventLike, event: StageEventLike): boolean {
  return (
    event.created_at >= open.created_at &&
    event.created_at <= open.created_at + STAGE_WINDOW_SECONDS
  );
}

/**
 * Deterministic post order: created_at, then seq when BOTH showings carry
 * one, then event id. `created_at` is whole seconds, so without seq two posts
 * in the same second would order by (random) id — not by when they were sent.
 */
export function compareShowings(
  a: { createdAt: number; eventId: string; seq?: number },
  b: { createdAt: number; eventId: string; seq?: number },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * Reduce an open event plus any candidate events (typically every kind-9 in
 * the channel window) into the session. Returns null when `open` is not a
 * valid Stage open. Pure; never throws on malformed input.
 */
export function reduceStageSession(
  open: StageEventLike,
  events: readonly StageEventLike[],
): StageSession | null {
  const openTag = stageOpenOf(open);
  const channelId = hTag(open);
  if (!openTag || !channelId) return null;
  const total = openTag.parts.length;

  const seen = new Set<string>();
  const showings: StageShowing[] = [];
  let closed = false;

  for (const event of events) {
    if (event.id === open.id || seen.has(event.id)) continue;
    if (event.kind !== 9) continue;
    const tag = parseStageTag(event.tags);
    if (!tag || tag.op === "open") continue;
    // §4.3 rules 1, 2, 3, 5 — shared by part and close.
    if (tag.s !== open.id) continue;
    if (event.pubkey !== open.pubkey) continue;
    if (hTag(event) !== channelId) continue;
    if (!withinWindow(open, event)) continue;
    seen.add(event.id);
    if (tag.op === "close") {
      closed = true;
      continue;
    }
    // Rule 4 — needs the palette, so it lives here, not in the parser.
    if (tag.i < 0 || tag.i >= total) continue;
    const palette = openTag.parts[tag.i];
    const own = ownImageUrl(event);
    if (own && own !== palette.url && typeof console !== "undefined") {
      console.warn(
        `[stage] part ${event.id} image differs from palette[${tag.i}]; showing the part's own image`,
      );
    }
    const speechEvent: SpeechEventLike = {
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      content: event.content,
      tags: event.tags,
    };
    showings.push({
      eventId: event.id,
      i: tag.i,
      hold: tag.hold,
      text: textWithoutAttachments(speechEvent).trim(),
      speakText: speakableText(speechEvent),
      imageUrl: own ?? palette.url,
      createdAt: event.created_at,
      ...(tag.seq === undefined ? {} : { seq: tag.seq }),
    });
  }

  showings.sort(compareShowings);
  return {
    openId: open.id,
    author: open.pubkey,
    channelId,
    title: openTag.title,
    voice: openTag.voice,
    openedAt: open.created_at,
    palette: openTag.parts,
    showings,
    closed,
  };
}

/**
 * §4.4 step 2: the history query for one session — the fully pushed `h`
 * path plus authors, bounded to the 24 h window.
 */
export function stageHistoryFilter(open: {
  pubkey: string;
  created_at: number;
  channelId: string;
}): NostrFilter {
  return {
    kinds: [9],
    "#h": [open.channelId],
    authors: [open.pubkey],
    since: open.created_at,
    until: open.created_at + STAGE_WINDOW_SECONDS,
    limit: 500,
  };
}

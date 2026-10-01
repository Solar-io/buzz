/**
 * The line under an item's title (Items artboard: "AI · The draft is
 * discarded when…").
 *
 * 1. The item's own `summary` tag — what the filing agent wrote (the base
 *    prompt tells agents to always pass `--summary`). Marked AI when the
 *    reporter is an agent.
 * 2. Otherwise the text it was captured from — the source message, or the
 *    item's body when there is no source message — as the reminders list
 *    handles a saved message (`reminders/lib/reminderSummary.ts`): short text
 *    verbatim, long text summarised by buzz-summary-bridge (marked AI), cut
 *    to 140 characters while that is loading or if it fails.
 * 3. Nothing to say → no line at all, never a dash.
 *
 * A `/bug` confirmation row is not a source worth quoting: it only restates
 * the title, so an item captured from one falls back to its body.
 *
 * Import-free apart from types and pure helpers, so `node --test` loads it.
 */

import {
  FALLBACK_PREVIEW_CHARS,
  SUMMARY_MIN_PREVIEW_CHARS,
  type SummaryState,
} from "../../reminders/lib/reminderSummary.ts";
import { plainText } from "../../../shared/lib/plainText.ts";
import type { ItemHead } from "./itemEvent.ts";
import { itemRowTag } from "./itemMessages.ts";

/** A source message as the Items page fetched it. */
export interface ItemSource {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}

/** The plain text an item was captured from, or null. */
export function capturedText(
  item: Pick<ItemHead, "body">,
  source: ItemSource | null,
): string | null {
  if (source && itemRowTag(source.tags) === null) {
    const text = plainText(source.content);
    if (text !== "") {
      return text;
    }
  }
  const body = plainText(item.body);
  return body === "" ? null : body;
}

/** The text to send the bridge, or null when no request is due. */
export function summaryRequestText(
  item: Pick<ItemHead, "summary">,
  captured: string | null,
): string | null {
  if (item.summary?.trim()) {
    return null;
  }
  return captured !== null && captured.length > SUMMARY_MIN_PREVIEW_CHARS
    ? captured
    : null;
}

export interface SummaryLine {
  text: string;
  /** Machine-written: an agent's summary tag, or the bridge's summary. */
  ai: boolean;
}

export function summaryLine(input: {
  item: Pick<ItemHead, "summary" | "title">;
  captured: string | null;
  reporterIsAgent: boolean;
  /** The bridge's state for `summaryRequestText`, when one was due. */
  state: SummaryState | null;
}): SummaryLine | null {
  const own = input.item.summary?.trim();
  if (own) {
    return { text: own, ai: input.reporterIsAgent };
  }
  const captured = input.captured;
  if (captured === null) {
    return null;
  }
  if (captured.length <= SUMMARY_MIN_PREVIEW_CHARS) {
    // Short text that only repeats the title says nothing new.
    return captured.toLowerCase() === input.item.title.trim().toLowerCase()
      ? null
      : { text: captured, ai: false };
  }
  if (input.state?.status === "ready") {
    return { text: input.state.summary, ai: true };
  }
  return {
    text: `${captured.slice(0, FALLBACK_PREVIEW_CHARS).trimEnd()}…`,
    ai: false,
  };
}

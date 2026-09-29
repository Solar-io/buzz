/**
 * Pure client-side logic for AI reminder summaries.
 *
 * A reminder's target preview is the WHOLE saved message (MessageRow passes
 * `message.content`), which made the reminders list a wall of text. Long
 * previews are summarised to 1-2 sentences by buzz-summary-bridge
 * (infra/buzz-summary-bridge, crichton 6368 → infra/port-registry.json:
 * buzz → summary_bridge_https), which fronts an Ollama Cloud model so the key
 * never reaches the browser.
 *
 * Privacy contract: only the target PREVIEW is ever sent. The private note is
 * never part of a request — `summaryRequestBody` is the single place the wire
 * body is built, and it reads the preview alone. Summaries live in the
 * in-memory query cache only; nothing is persisted.
 *
 * Import-free (type imports only), so `node --test` loads it.
 */

import type { Reminder } from "./reminderTypes.ts";

/** Previews at or under this length are shown as-is — no summary request. */
export const SUMMARY_MIN_PREVIEW_CHARS = 160;

/** While a summary is loading (or failed) the preview is cut to this length. */
export const FALLBACK_PREVIEW_CHARS = 140;

/** Build the bridge URL from the hostname the app is served from. */
export function summaryBridgeUrl(hostname: string): string {
  return `https://${hostname}:6368/summarize`;
}

/**
 * The text to summarise for this reminder, or null when there is nothing
 * worth summarising (no preview, or a preview short enough to show as-is).
 * Never includes the note.
 */
export function summaryInputFor(reminder: Reminder): string | null {
  const preview = reminder.content.target?.preview?.trim();
  if (!preview || preview.length <= SUMMARY_MIN_PREVIEW_CHARS) {
    return null;
  }
  return preview;
}

/** The exact POST body for this reminder, or null when no request is due. */
export function summaryRequestBody(reminder: Reminder): string | null {
  const text = summaryInputFor(reminder);
  return text === null ? null : JSON.stringify({ text });
}

/**
 * Validate a `/summarize` reply. Returns the summary, or null for anything
 * that is not `{summary: <non-empty string>}` — a malformed reply must never
 * render as a summary.
 */
export function parseSummaryResponse(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const summary = (raw as Record<string, unknown>).summary;
  if (typeof summary !== "string") {
    return null;
  }
  const trimmed = summary.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Fetch the summary for one reminder. Throws on transport failure, a non-2xx
 * status, or a malformed reply; resolves null when the reminder needs no
 * summary (so the caller never has to special-case short previews).
 */
export async function fetchReminderSummary(
  reminder: Reminder,
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string | null> {
  const body = summaryRequestBody(reminder);
  if (body === null) {
    return null;
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(`summary bridge HTTP ${response.status}`);
  }
  const summary = parseSummaryResponse(await response.json());
  if (summary === null) {
    throw new Error("summary bridge returned a malformed reply");
  }
  return summary;
}

export type SummaryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; summary: string };

/**
 * What the row shows under/as the reminder's main line.
 *
 * - no preview                → null (row falls back to note / "Reminder")
 * - short preview             → the preview, verbatim
 * - long preview, ready       → the AI summary (`isSummary: true`)
 * - long preview, loading/err → the preview cut to 140 chars + "…"
 */
export function displayText(
  reminder: Reminder,
  state: SummaryState,
): { text: string; isSummary: boolean } | null {
  const preview = reminder.content.target?.preview?.trim();
  if (!preview) {
    return null;
  }
  if (summaryInputFor(reminder) === null) {
    return { text: preview, isSummary: false };
  }
  if (state.status === "ready") {
    return { text: state.summary, isSummary: true };
  }
  return {
    text: `${preview.slice(0, FALLBACK_PREVIEW_CHARS).trimEnd()}…`,
    isSummary: false,
  };
}

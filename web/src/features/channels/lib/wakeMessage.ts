/**
 * Scheduled-wake detection — Sam's 2026-09-17 "collapsed notifications" ruling.
 *
 * Reminder firings from buzz-services are agent machinery, not conversation:
 * the text is the instruction a woken seat reads on wake ("continue: …",
 * "DWIGHT ROLL-UP (2h grid) … Silence = failure"), and every firing posts as
 * ONE service identity (`jobs/reminders.ts` sweeps → `core/poster.ts` → the
 * `buzz` CLI as BUZZ_SERVICES_KEY). Sam reads that raw machinery as channel
 * noise, so the timeline collapses it into a one-line "scheduled wake" row
 * that expands on tap (ScheduledWakeRow).
 *
 * Detection is SENDER-based, deliberately:
 *
 * - It collapses the existing backlog too — the complaint included messages
 *   already sitting in the channels, which a newly-tagged event scheme would
 *   never reach.
 * - It needs no protocol change: the CLI `messages send` has no arbitrary-tag
 *   passthrough, so a tag marker would mean a new binary + restaged swap
 *   window to accomplish what the sender identity already encodes.
 *
 * Kind is checked alongside the sender (kind 9 chat only): the same service
 * identity also posts #alerts digests as forum kinds 45001/45003, which keep
 * their own rendering — only plain wake pings collapse. The default key set
 * is overridable with VITE_WAKE_SERVICE_PUBKEYS (comma-separated) so a
 * different deployment (or a second services identity) needs no rebuild of
 * the constant's home.
 */

/** Plain channel-chat kind — `TIMELINE_KINDS` member used by reminder pings. */
const CHANNEL_CHAT_KIND = 9;

/** buzz-services reminder identity (BUZZ_SERVICES_KEY), 2026-09-17. */
const DEFAULT_WAKE_SERVICE_PUBKEYS = [
  "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271",
];

function resolveWakeServicePubkeys(): string[] {
  // Env vars arrive untyped from import.meta.env — cast, never infer. The
  // typeof guard keeps the module importable under the node test runner,
  // where vite never injects `env` (relay-url.ts solves the same problem by
  // only touching env inside browser-only calls; this constant resolves at
  // import time, so the guard lives here instead).
  const raw =
    typeof import.meta.env === "undefined"
      ? undefined
      : (import.meta.env.VITE_WAKE_SERVICE_PUBKEYS as string | undefined);
  if (!raw) return DEFAULT_WAKE_SERVICE_PUBKEYS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Identities whose kind-9 posts are scheduled machinery. */
export const WAKE_SERVICE_PUBKEYS: string[] = resolveWakeServicePubkeys();

/** True when a timeline message is a reminder firing — collapse it. */
export function isScheduledWake(
  message: Pick<TimelineMessageShape, "authorPubkey" | "kind">,
): boolean {
  return (
    message.kind === CHANNEL_CHAT_KIND &&
    WAKE_SERVICE_PUBKEYS.includes(message.authorPubkey)
  );
}

/**
 * One-line preview for the collapsed row: first line of the wake text,
 * whitespace-run squeezed, so a stack of wake rows stays scannable and each
 * remains distinguishable from its neighbors.
 */
export function wakePreview(text: string, maxChars = 72): string {
  const firstLine = text.trim().split("\n", 1)[0] ?? "";
  const squeezed = firstLine.replace(/\s+/g, " ").trim();
  if (squeezed.length <= maxChars) return squeezed;
  return `${squeezed.slice(0, maxChars - 1).trimEnd()}…`;
}

/** The structural subset of TimelineMessage this module needs (keeps lib pure). */
interface TimelineMessageShape {
  authorPubkey: string;
  kind: number;
}

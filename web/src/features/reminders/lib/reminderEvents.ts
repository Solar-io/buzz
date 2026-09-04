import type { ReminderContent, ReminderStatus } from "./reminderTypes.ts";

/**
 * The public tag set of a `kind:30300` event, as pure data.
 *
 * The tags are the only part of a reminder the relay can read, and every rule
 * about them is a NIP-ER MUST that fails silently when broken — a terminal
 * reminder that keeps `not_before` re-fires; an `expiration` at or below
 * `not_before` is rejected by the relay with
 * `invalid: expiration before not_before`. So they are built here, without
 * crypto or a socket, where a test can pin them.
 */

/** NIP-31 fallback text for clients that cannot decrypt the content. */
export const REMINDER_ALT_TEXT = "Encrypted reminder";

/** Completed reminders are cleaned up 30–90 days out (NIP-ER's suggestion). */
export const EXPIRATION_MIN_DAYS = 30;
export const EXPIRATION_MAX_DAYS = 90;

const DAY_SECONDS = 86_400;

/**
 * A jittered cleanup time for a terminal reminder.
 *
 * Jittered rather than fixed so a user completing twenty reminders in one
 * session does not hand the relay twenty rows expiring in the same second.
 * `random` is injectable so the range can be pinned at both ends by a test.
 */
export function jitteredExpiration(
  now: number,
  random: () => number = Math.random,
): number {
  const span = EXPIRATION_MAX_DAYS - EXPIRATION_MIN_DAYS;
  const days = EXPIRATION_MIN_DAYS + Math.floor(random() * (span + 1));
  return now + days * DAY_SECONDS;
}

/**
 * Tags for a PENDING reminder (create and snooze both land here).
 *
 * Exactly one `not_before`, and no `expiration`: NIP-ER says an expiration
 * SHOULD NOT be set on a pending reminder, and one that slipped below
 * `not_before` would have the relay delete the reminder before it ever came
 * due.
 */
export function pendingReminderTags(
  dTag: string,
  notBefore: number,
): string[][] {
  return [
    ["d", dTag],
    ["not_before", String(notBefore)],
    ["alt", REMINDER_ALT_TEXT],
  ];
}

/**
 * Tags for a TERMINAL reminder (done or cancelled).
 *
 * `not_before` is OMITTED, which is the whole point: the relay cannot read
 * `status`, so dropping the tag is the only way to tell it "stop scheduling
 * this". A terminal replacement that kept `not_before` would keep receiving
 * due signals forever.
 */
export function terminalReminderTags(
  dTag: string,
  expiration: number,
): string[][] {
  return [
    ["d", dTag],
    ["alt", REMINDER_ALT_TEXT],
    ["expiration", String(expiration)],
  ];
}

/** The plaintext payload, with `undefined` fields dropped by JSON.stringify. */
export function reminderPlaintext(content: ReminderContent): string {
  return JSON.stringify({
    target: content.target,
    status: content.status,
    note: content.note,
  });
}

/** The content for a status transition, preserving target and note. */
export function transitionContent(
  content: ReminderContent,
  status: ReminderStatus,
): ReminderContent {
  return { ...content, status };
}

/**
 * A reminder `d` tag with 128 bits of entropy.
 *
 * NIP-ER makes this a MUST and `crypto.randomUUID()` does NOT satisfy it —
 * UUIDv4 spends 6 bits on version and variant, leaving 122. Sixteen raw
 * random bytes is the smallest thing that does.
 */
export function randomDTag(
  fillRandom: (array: Uint8Array<ArrayBuffer>) => void = (array) => {
    crypto.getRandomValues(array);
  },
): string {
  const bytes = new Uint8Array(new ArrayBuffer(16));
  fillRandom(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

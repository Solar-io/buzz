import type {
  Reminder,
  ReminderContent,
  ReminderTarget,
} from "./reminderTypes.ts";

/**
 * Parsing and validation of a reminder's public tags and decrypted payload.
 *
 * Pure by design: every rule NIP-ER states as a client MUST is a branch in
 * here, and the relay's own validator is the thing being mirrored, so it has
 * to be testable without a relay, a key, or a browser.
 */

/**
 * Parse a `not_before` tag value exactly as strictly as the relay does.
 *
 * NIP-ER: decimal ASCII digits only, no sign, whitespace, decimal point, or
 * leading zero except `"0"`, and within `Number.MAX_SAFE_INTEGER`. Anything
 * else the relay calls malformed, so the client must ignore it rather than
 * coercing it — `Number(" 12 ")` is 12 and `Number("1e9")` is a billion, and
 * both would schedule a reminder the relay never agreed to.
 */
export function parseNotBefore(raw: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The single `not_before` from an event's tags.
 *
 * NIP-ER allows AT MOST ONE. Two is malformed, and returning the first would
 * pick one of two contradictory due times — so a duplicate yields undefined,
 * which downgrades the reminder to "not schedulable" rather than guessing.
 */
export function extractNotBefore(tags: string[][]): number | undefined {
  const values = tags.filter((tag) => tag[0] === "not_before");
  if (values.length !== 1) {
    return undefined;
  }
  const raw = values[0][1];
  return typeof raw === "string" ? parseNotBefore(raw) : undefined;
}

/** The single `d` tag; null when absent, empty, or duplicated (all invalid). */
export function extractDTag(tags: string[][]): string | null {
  const values = tags.filter((tag) => tag[0] === "d");
  if (values.length !== 1) {
    return null;
  }
  const value = values[0][1];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTarget(value: unknown): ReminderTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;

  // The desktop's shape — the one this client writes, and the one a reminder
  // created in the Buzz desktop app carries.
  if (
    typeof raw.eventId === "string" &&
    typeof raw.channelId === "string" &&
    typeof raw.preview === "string" &&
    typeof raw.authorPubkey === "string"
  ) {
    return {
      eventId: raw.eventId,
      channelId: raw.channelId,
      preview: raw.preview,
      authorPubkey: raw.authorPubkey,
    };
  }

  // NIP-ER's documented shape (`{id, a, relays, preview}`) from some other
  // client. It carries no channel, so the reminder cannot be jumped to — but
  // showing it un-navigable beats the desktop's behaviour of dropping the
  // whole reminder, which makes another client's reminders silently vanish.
  if (typeof raw.id === "string" && /^[0-9a-f]{64}$/.test(raw.id)) {
    return {
      eventId: raw.id,
      channelId: "",
      preview: typeof raw.preview === "string" ? raw.preview : "",
      authorPubkey: "",
    };
  }

  return null;
}

/**
 * Validate decrypted reminder plaintext.
 *
 * NIP-ER requires clients to ignore plaintext that is not a JSON object, has
 * an unknown `status`, or has a malformed target/note; and a pending reminder
 * must carry either a target reference or a non-empty note. Everything
 * off-shape fails CLOSED — returning null drops the reminder rather than
 * rendering a half-parsed one.
 */
export function parseReminderContent(
  plaintext: string,
): ReminderContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  if (
    raw.status !== "pending" &&
    raw.status !== "done" &&
    raw.status !== "cancelled"
  ) {
    return null;
  }
  if (raw.note !== undefined && typeof raw.note !== "string") {
    return null;
  }

  let target: ReminderTarget | undefined;
  if (raw.target !== undefined) {
    const candidate = parseTarget(raw.target);
    if (!candidate) {
      return null;
    }
    target = candidate;
  }

  const note = typeof raw.note === "string" ? raw.note : undefined;
  if (!target && !(note && note.length > 0)) {
    return null;
  }

  return { status: raw.status, target, note };
}

/**
 * NIP-01 replacement: the winning head per reminder address is the highest
 * `created_at`, ties broken by the LOWEST lexicographic event id.
 *
 * A relay replays stored events and can hand back an older version alongside
 * the current one — so "last one wins" would show a snoozed reminder at its
 * original time, or a completed one as still pending, depending purely on
 * delivery order.
 */
export function pickHeads(reminders: readonly Reminder[]): Reminder[] {
  const heads = new Map<string, Reminder>();
  for (const reminder of reminders) {
    const current = heads.get(reminder.id);
    if (
      !current ||
      reminder.createdAt > current.createdAt ||
      (reminder.createdAt === current.createdAt &&
        reminder.eventId < current.eventId)
    ) {
      heads.set(reminder.id, reminder);
    }
  }
  return [...heads.values()];
}

/**
 * The `created_at` a replacement must carry to win against the version it
 * replaces.
 *
 * `now` normally exceeds the head's stamp and is used as-is. When it does not
 * — a same-second snooze, or a clock that has gone backwards — the
 * replacement takes `head + 1`, because a replacement stamped at or before
 * the head loses under NIP-01 ordering and the write silently does nothing.
 */
export function replacementCreatedAt(
  headCreatedAt: number,
  now: number,
): number {
  return Math.max(now, headCreatedAt + 1);
}

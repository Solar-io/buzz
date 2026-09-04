/**
 * NIP-ER event reminders (`docs/nips/NIP-ER.md`).
 *
 * A reminder is a `kind:30300` addressable event — NOT client-local state and
 * NOT a relay-side row. It is keyed `(pubkey, 30300, d)`, its content is
 * NIP-44 self-encrypted, and the only thing the relay can read is the public
 * `not_before` tag. That is what makes reminders SYNC: the same key on
 * another device replays them, and this relay pushes a due signal
 * (`crates/buzz-relay/src/nip11.rs` advertises `due_delivery_mode: "push"`).
 *
 * `KIND_EVENT_REMINDER` is in `AUTHOR_ONLY_KINDS`
 * (`crates/buzz-core/src/kind.rs`), so every read is NIP-42 gated and a REQ
 * whose only kind is 30300 MUST carry `authors: [self]` — see
 * `author_only_filters_authorized` in `crates/buzz-relay/src/handlers/req.rs`.
 */

/** NIP-ER reminder kind. `buzz_core::kind::KIND_EVENT_REMINDER`. */
export const KIND_EVENT_REMINDER = 30300;

/** NIP-09 deletion, for hard-deleting a reminder address. */
export const KIND_DELETION = 5;

export type ReminderStatus = "pending" | "done" | "cancelled";

/**
 * The message a reminder points at.
 *
 * This is the DESKTOP's target shape, not the one NIP-ER's Content section
 * documents (`{id, a, relays, preview}`). It is deliberate: the desktop's
 * `parseTarget` (`desktop/src/features/reminders/lib/reminderService.ts`)
 * returns null — dropping the whole reminder — unless all four of these are
 * strings, so a spec-shaped target written by the web would be invisible on
 * the desktop. Cross-client parity with the sibling that already ships wins
 * over the document; the divergence is called out in the reader, which also
 * accepts the spec shape rather than dropping it.
 */
export interface ReminderTarget {
  /** Event id of the message being reminded about. */
  eventId: string;
  /** Channel the message lives in. */
  channelId: string;
  /** Cached preview text of the target message. */
  preview: string;
  /** Author pubkey of the target message. */
  authorPubkey: string;
}

/** The decrypted `kind:30300` payload. */
export interface ReminderContent {
  /** Target message; absent for a note-only reminder (NIP-ER allows either). */
  target?: ReminderTarget;
  /** Optional private note. */
  note?: string;
  status: ReminderStatus;
}

/** One reminder, decrypted and normalised. */
export interface Reminder {
  /** The `d` tag — the reminder's stable address component. */
  id: string;
  /** Unix seconds the reminder comes due. Absent on done/cancelled. */
  notBefore?: number;
  content: ReminderContent;
  /** The event's `created_at`, which orders replacements. */
  createdAt: number;
  /** The event id, for dedupe against a re-delivered due signal. */
  eventId: string;
}

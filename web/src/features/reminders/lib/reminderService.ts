import type { RelaySession } from "@/shared/api/relay-session";
import type {
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "@/shared/lib/nostr-signer";

import {
  extractDTag,
  extractNotBefore,
  parseReminderContent,
  pickHeads,
  replacementCreatedAt,
} from "./reminderContent.ts";
import {
  jitteredExpiration,
  pendingReminderTags,
  randomDTag,
  reminderPlaintext,
  terminalReminderTags,
  transitionContent,
} from "./reminderEvents.ts";
import { queryOnce, type QueryableSession } from "./relayQuery.ts";
import {
  KIND_EVENT_REMINDER,
  type Reminder,
  type ReminderContent,
  type ReminderTarget,
} from "./reminderTypes.ts";

/**
 * Relay IO for NIP-ER reminders.
 *
 * Reminders are `kind:30300` events encrypted to the author with NIP-44 and
 * readable only by the author (`AUTHOR_ONLY_KINDS`), so this module needs the
 * viewer's own key on BOTH sides — the web keeps it in the local keystore,
 * where the desktop keeps it in Rust behind `nip44_encrypt_to_self`.
 *
 * A session signing through a NIP-07 extension cannot do this: the web's
 * `nip44EncryptTo` needs the raw secret to derive the conversation key, and
 * an extension will not export it. That surfaces as a thrown, explained error
 * rather than an empty reminder list — the same choice the agent memory
 * viewer makes.
 */

/** One page of reminders. The relay clamps at 1000; 200 covers any real user. */
export const REMINDER_FETCH_LIMIT = 200;

type PublishableSession = QueryableSession & Pick<RelaySession, "publish">;

export class ReminderKeyUnavailableError extends Error {
  constructor() {
    super(
      "Reminders need the unlocked local key — this session signs with a browser extension, which cannot derive the NIP-44 conversation key.",
    );
    this.name = "ReminderKeyUnavailableError";
  }
}

/**
 * The three signer capabilities this module borrows.
 *
 * Injected, and resolved through a DYNAMIC import when absent, so the module
 * carries no top-level value import behind the `@/` alias. That is what lets
 * `node --test` (which has no path-alias resolver) drive create / snooze /
 * complete / fetch against a fake relay and a fake cipher, rather than only
 * testing the tag builders in isolation. Same technique as
 * `features/channels/lib/unreact.ts`.
 */
export interface ReminderCrypto {
  encryptToSelf(plaintext: string, selfPubkey: string): string;
  decryptFromSelf(ciphertext: string, selfPubkey: string): string;
  sign(
    template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
  ): Promise<SignedNostrEvent>;
}

let cachedSigner: Promise<typeof import("@/shared/lib/nostr-signer")> | null =
  null;

/**
 * The app's real signer, wrapped in the {@link ReminderCrypto} shape.
 *
 * `nip44EncryptTo` / `nip44DecryptFrom` are synchronous, so the module has to
 * be loaded before the first call rather than awaited inside it — hence a
 * resolver rather than a constant.
 */
export async function loadReminderCrypto(): Promise<ReminderCrypto> {
  cachedSigner ??= import("@/shared/lib/nostr-signer");
  const signer = await cachedSigner;
  return {
    encryptToSelf: (plaintext, selfPubkey) =>
      signer.nip44EncryptTo(plaintext, selfPubkey).ciphertext,
    decryptFromSelf: (ciphertext, selfPubkey) =>
      signer.nip44DecryptFrom(ciphertext, selfPubkey).plaintext,
    sign: (template) => signer.signNostrEvent(template),
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/**
 * Decrypt one `kind:30300` event into a reminder, or null.
 *
 * Null covers several distinct situations — no `d` tag, ciphertext this key
 * cannot open, plaintext that fails NIP-ER's content rules — and all of them
 * mean "not actionable", so they collapse rather than throwing and taking the
 * whole page down with them.
 */
export function decryptReminder(
  event: SignedNostrEvent,
  selfPubkey: string,
  crypto: ReminderCrypto,
): Reminder | null {
  const dTag = extractDTag(event.tags);
  if (!dTag) {
    return null;
  }
  let plaintext: string;
  try {
    plaintext = crypto.decryptFromSelf(event.content, selfPubkey);
  } catch {
    return null;
  }
  const content = parseReminderContent(plaintext);
  if (!content) {
    return null;
  }
  return {
    id: dTag,
    notBefore: extractNotBefore(event.tags),
    content,
    createdAt: event.created_at,
    eventId: event.id,
  };
}

/**
 * Every reminder for the signed-in author.
 *
 * `authors` is mandatory, not an optimisation: a REQ whose only kind is 30300
 * is refused outright without it (`author_only_filters_authorized`,
 * `crates/buzz-relay/src/handlers/req.rs`).
 *
 * The result is reduced to replacement HEADS. A relay replay can hand back a
 * superseded version alongside the current one, and rendering both shows a
 * snoozed reminder twice at two different times, or a completed one as still
 * pending.
 */
export async function fetchReminders(
  session: QueryableSession,
  selfPubkey: string,
  crypto?: ReminderCrypto,
): Promise<Reminder[]> {
  const cipher = crypto ?? (await loadReminderCryptoOrThrow());
  const events = await queryOnce(session, {
    kinds: [KIND_EVENT_REMINDER],
    authors: [selfPubkey],
    limit: REMINDER_FETCH_LIMIT,
  });
  const decrypted: Reminder[] = [];
  for (const event of events) {
    const reminder = decryptReminder(event, selfPubkey, cipher);
    if (reminder) {
      decrypted.push(reminder);
    }
  }
  return pickHeads(decrypted);
}

async function loadReminderCryptoOrThrow(): Promise<ReminderCrypto> {
  try {
    return await loadReminderCrypto();
  } catch {
    throw new ReminderKeyUnavailableError();
  }
}

async function publishReminder(
  session: PublishableSession,
  selfPubkey: string,
  crypto: ReminderCrypto,
  input: { tags: string[][]; content: ReminderContent; createdAt: number },
): Promise<SignedNostrEvent> {
  let ciphertext: string;
  try {
    ciphertext = crypto.encryptToSelf(
      reminderPlaintext(input.content),
      selfPubkey,
    );
  } catch {
    // The only way self-encryption fails here is a missing local secret —
    // a NIP-07-only session. Say that, rather than surfacing the signer's
    // internal message.
    throw new ReminderKeyUnavailableError();
  }
  const event = await crypto.sign({
    kind: KIND_EVENT_REMINDER,
    created_at: input.createdAt,
    tags: input.tags,
    content: ciphertext,
  });
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(result.message || "The relay rejected the reminder.");
  }
  return event;
}

/** Create a new pending reminder at a fresh address. */
export async function createReminder(
  session: PublishableSession,
  selfPubkey: string,
  input: { target?: ReminderTarget; note?: string; notBefore: number },
  crypto?: ReminderCrypto,
): Promise<SignedNostrEvent> {
  const cipher = crypto ?? (await loadReminderCryptoOrThrow());
  return publishReminder(session, selfPubkey, cipher, {
    tags: pendingReminderTags(randomDTag(), input.notBefore),
    content: { target: input.target, note: input.note, status: "pending" },
    createdAt: nowSeconds(),
  });
}

/** Move a reminder's due time out — a pending replacement at the same address. */
export async function snoozeReminder(
  session: PublishableSession,
  selfPubkey: string,
  reminder: Reminder,
  notBefore: number,
  crypto?: ReminderCrypto,
): Promise<SignedNostrEvent> {
  const cipher = crypto ?? (await loadReminderCryptoOrThrow());
  return publishReminder(session, selfPubkey, cipher, {
    tags: pendingReminderTags(reminder.id, notBefore),
    content: transitionContent(reminder.content, "pending"),
    createdAt: replacementCreatedAt(reminder.createdAt, nowSeconds()),
  });
}

async function terminate(
  session: PublishableSession,
  selfPubkey: string,
  reminder: Reminder,
  status: "done" | "cancelled",
  crypto?: ReminderCrypto,
): Promise<SignedNostrEvent> {
  const cipher = crypto ?? (await loadReminderCryptoOrThrow());
  const now = nowSeconds();
  return publishReminder(session, selfPubkey, cipher, {
    tags: terminalReminderTags(reminder.id, jitteredExpiration(now)),
    content: transitionContent(reminder.content, status),
    createdAt: replacementCreatedAt(reminder.createdAt, now),
  });
}

/** Mark a reminder done. */
export function completeReminder(
  session: PublishableSession,
  selfPubkey: string,
  reminder: Reminder,
  crypto?: ReminderCrypto,
): Promise<SignedNostrEvent> {
  return terminate(session, selfPubkey, reminder, "done", crypto);
}

/** Cancel a reminder without completing it. */
export function cancelReminder(
  session: PublishableSession,
  selfPubkey: string,
  reminder: Reminder,
  crypto?: ReminderCrypto,
): Promise<SignedNostrEvent> {
  return terminate(session, selfPubkey, reminder, "cancelled", crypto);
}

import { parsePubkeyInput } from "@/features/dms/lib/dmInput.ts";
import { truncatePubkey } from "@/shared/lib/pubkey.ts";

/**
 * Raw-key entry for the huddle add-agent dialog.
 *
 * The picker's registry list only exists for the OWNER of the agents — it is
 * the owner's kind-30177 rows — but the add itself is pubkey-based (kind-9000,
 * role `bot`), so any huddle member can add an agent whose key they hold.
 * This module is the pure half of that second path: parse the pasted key,
 * refuse the duplicate the plan layer would refuse anyway (with a clearer
 * message than a round-trip to the relay), and build the display name a
 * key has no other source for. See `AddHuddleAgentDialog` for the UI.
 */

export type RawAgentEntryResult =
  | { ok: true; pubkey: string; name: string }
  | { ok: false; error: string };

/**
 * Validate one pasted key for adding to this huddle.
 *
 * Accepts exactly what `parsePubkeyInput` accepts — a raw 64-hex key or an
 * npub — and rejects with a specific, user-facing message otherwise (an nsec
 * paste surfaces the secret-key warning verbatim). The duplicate check runs
 * BEFORE anything is published: the plan layer refuses it too
 * (`huddleAgentAddPlan`), but its message then costs a sign-and-publish
 * round-trip the client could have prevented.
 */
export function rawHuddleAgentEntry(
  raw: string,
  currentAgentPubkeys: readonly string[],
): RawAgentEntryResult {
  const parsed = parsePubkeyInput(raw.trim());
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const pubkey = parsed.pubkey.toLowerCase();
  const present = currentAgentPubkeys.some(
    (key) => key.toLowerCase() === pubkey,
  );
  if (present) {
    return { ok: false, error: "That agent is already in this huddle." };
  }
  return { ok: true, pubkey, name: agentNameFromPubkey(pubkey) };
}

/**
 * The display name for an agent known only by its key.
 *
 * A registry row carries a human name; a pasted key carries nothing, so the
 * name is derived instead of invented: `agent ` + the one canonical compact
 * pubkey form (`truncatePubkey`), matching what the list rows show beside
 * their names. The name is a label for toasts and messages — identity is the
 * pubkey itself.
 */
export function agentNameFromPubkey(pubkey: string): string {
  return `agent ${truncatePubkey(pubkey)}`;
}

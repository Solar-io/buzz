import { npubEncode } from "nostr-tools/nip19";
import { truncatePubkey } from "../../../shared/lib/pubkey.ts";

/**
 * npub presentation for the profile surfaces.
 *
 * The profile card shows an npub rather than the raw hex the timeline uses:
 * npub is the form a person can paste into another client, and it carries a
 * bech32 checksum, so a mis-copied one fails to decode instead of silently
 * addressing a different key. The full string is what gets copied; only the
 * label is shortened, and it is shortened by the canonical
 * `shared/lib/pubkey.ts` helper — hand-rolled `.slice()` display forms are
 * what the repo's pubkey-truncation guard exists to prevent.
 */

/** A Nostr pubkey is exactly 32 bytes of lowercase-or-uppercase hex. */
const HEX_PUBKEY = /^[0-9a-fA-F]{64}$/;

/**
 * bech32 npub for a hex pubkey, or null when the key is not encodable.
 *
 * The length check is not redundant with `npubEncode`'s own error handling:
 * nostr-tools happily encodes a short hex string (`"abc"` becomes a valid
 * bech32 `npub106246s`), which would present a truncated key as a whole
 * identity. Only a full 32-byte key is a pubkey.
 */
export function toNpub(pubkey: string): string | null {
  if (!HEX_PUBKEY.test(pubkey)) {
    return null;
  }
  try {
    return npubEncode(pubkey);
  } catch {
    // Defensive: callers fall back to hex rather than rendering a blank
    // identity line.
    return null;
  }
}

/**
 * Short, human-scannable identity label.
 *
 * Prefers the truncated npub; falls back to the truncated hex when the key
 * cannot be encoded, so the line never disappears. Recognition aid only — a
 * truncated key is grindable and is never an identity proof.
 */
export function npubLabel(pubkey: string): string {
  const encoded = toNpub(pubkey);
  return truncatePubkey(encoded ?? pubkey);
}

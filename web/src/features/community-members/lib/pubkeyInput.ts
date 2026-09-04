/**
 * "Paste a person" — turn whatever a user pastes into a hex pubkey.
 *
 * Accepts a bare 64-char hex key, an `npub1…`, an `nprofile1…` (people copy
 * these out of other clients without noticing the difference), and any of
 * those wrapped in a `nostr:` URI. Returns null rather than throwing, because
 * the caller renders "that is not a public key" beside a field the user is
 * still typing into.
 *
 * The bech32 forms carry a checksum, which is the reason to prefer them: a
 * mistyped npub fails to decode instead of silently naming a different key.
 * A mistyped hex key is still a valid key — nothing can catch that, which is
 * why the add flow shows the resolved profile before it acts.
 */

import { decode } from "nostr-tools/nip19";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

export function parsePubkeyInput(raw: string): string | null {
  let value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  if (value.toLowerCase().startsWith("nostr:")) {
    value = value.slice("nostr:".length);
  }
  const lower = value.toLowerCase();
  if (HEX_PUBKEY.test(lower)) {
    return lower;
  }
  if (!lower.startsWith("npub1") && !lower.startsWith("nprofile1")) {
    return null;
  }
  try {
    const decoded = decode(lower);
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return decoded.data.toLowerCase();
    }
    if (decoded.type === "nprofile") {
      const pubkey = (decoded.data as { pubkey?: unknown }).pubkey;
      return typeof pubkey === "string" ? pubkey.toLowerCase() : null;
    }
    return null;
  } catch {
    // Bad checksum, wrong prefix, truncated paste.
    return null;
  }
}

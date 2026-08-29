/**
 * nsec/hex parsing and encoding for key entry and device pairing.
 *
 * Pairing QRs carry the `nsec…` form: it is checksummed (bech32), so a bad
 * scan fails parsing instead of importing a wrong key. Hex is accepted for
 * manual entry and normalized case-insensitively.
 */

import { decode as nip19Decode, nsecEncode } from "nostr-tools/nip19";

export type ParsedKey =
  | { ok: true; secretKey: Uint8Array; nsec: string }
  | { ok: false; error: string };

/** Parse user/QR-supplied key material into raw bytes plus canonical nsec. */
export function parseSecretKeyInput(input: string): ParsedKey {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter your key." };
  }
  if (trimmed.startsWith("nsec1")) {
    try {
      const decoded = nip19Decode(trimmed);
      if (decoded.type !== "nsec") {
        return {
          ok: false,
          error: "That is a public key (npub), not a secret key.",
        };
      }
      return { ok: true, secretKey: decoded.data, nsec: trimmed };
    } catch {
      return { ok: false, error: "Invalid nsec key (checksum failed)." };
    }
  }
  if (trimmed.startsWith("npub1")) {
    return {
      ok: false,
      error: "That is a public key (npub), not a secret key.",
    };
  }
  const hex = trimmed.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return {
      ok: false,
      error: "Keys are nsec1… strings or 64-character hex.",
    };
  }
  const secretKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    secretKey[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return { ok: true, secretKey, nsec: nsecEncode(secretKey) };
}

/** Canonical QR payload for pairing: the nsec form of the key. */
export function nsecFromSecretKey(secretKey: Uint8Array): string {
  return nsecEncode(secretKey);
}

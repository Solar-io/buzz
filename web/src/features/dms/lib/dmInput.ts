import { decode as nip19Decode } from "nostr-tools/nip19";

export type PubkeyParseResult =
  | { ok: true; pubkey: string }
  | { ok: false; error: string };

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Accept a raw 64-hex pubkey or an npub (bech32). Everything else — including
 * an nsec, which people paste by mistake — is rejected with a specific error.
 */
export function parsePubkeyInput(raw: string): PubkeyParseResult {
  const trimmed = raw.trim();
  if (HEX64.test(trimmed)) {
    return { ok: true, pubkey: trimmed.toLowerCase() };
  }
  // BIP-173 permits all-uppercase bech32; normalize before matching.
  const lowered = trimmed.toLowerCase();
  if (/^[a-z0-9]+1[02-9ac-hj-np-z]+$/.test(lowered)) {
    try {
      const decoded = nip19Decode(lowered);
      if (decoded.type === "npub" && HEX64.test(decoded.data)) {
        return { ok: true, pubkey: decoded.data };
      }
      if (decoded.type === "nsec") {
        return {
          ok: false,
          error: "That is a SECRET key (nsec), not a public key.",
        };
      }
      return {
        ok: false,
        error: `That is a ${decoded.type} address, not a public key (npub).`,
      };
    } catch {
      // malformed bech32 — fall through to the generic error
    }
  }
  return {
    ok: false,
    error: "Enter a public key: 64 hex characters or an npub… address.",
  };
}

export type ParticipantSetResult =
  | { ok: true; pubkeys: string[] }
  | { ok: false; error: string };

/**
 * Validate the OTHER participants for a DM open (kind 41010): dedupe, drop
 * self, enforce the relay's 1–8 others rule (handle_dm_open rejects empty or
 * >8 p tags). Input entries are already-parsed pubkeys or raw strings.
 */
export function buildOtherParticipants(
  inputs: string[],
  selfPubkey: string,
): ParticipantSetResult {
  const parsed: string[] = [];
  for (const input of inputs) {
    const result = parsePubkeyInput(input);
    if (!result.ok) {
      return result;
    }
    if (result.pubkey !== selfPubkey && !parsed.includes(result.pubkey)) {
      parsed.push(result.pubkey);
    }
  }
  if (parsed.length === 0) {
    return {
      ok: false,
      error: "Add at least one other participant.",
    };
  }
  if (parsed.length > 8) {
    return {
      ok: false,
      error: "A DM can have at most 8 other participants.",
    };
  }
  return { ok: true, pubkeys: parsed };
}

/**
 * The DM-open response rides the relay OK message as
 * `response:{"channel_id":"<uuid>","created":bool}` (handle_dm_open step 6).
 * The channel id is SERVER-DERIVED from the participant set — a client uuid
 * would only be a guess, so this is the only authoritative source.
 */
export function extractOpenDmChannelId(message: string): string | null {
  const jsonPart = message.startsWith("response:")
    ? message.slice("response:".length)
    : message;
  try {
    const parsed = JSON.parse(jsonPart) as { channel_id?: unknown };
    if (typeof parsed.channel_id === "string" && parsed.channel_id.length > 0) {
      return parsed.channel_id;
    }
  } catch {
    // not JSON — not an open-DM response
  }
  return null;
}

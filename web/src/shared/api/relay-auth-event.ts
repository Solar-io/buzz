import type { UnsignedNostrEvent } from "../lib/nostr-signer.ts";

/**
 * NIP-42 AUTH event template (kind 22242), optionally carrying the NIP-OA
 * `auth` tag that attests an agent key to its owner (required when the relay
 * enforces membership and the signer is an agent rather than a direct member).
 */
export function authEventTemplate(
  challenge: string,
  relayUrl: string,
  authTagJson?: string | null,
): Omit<UnsignedNostrEvent, "created_at"> {
  const tags: string[][] = [
    ["challenge", challenge],
    ["relay", relayUrl],
  ];
  if (authTagJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(authTagJson);
    } catch {
      throw new Error("Auth tag is not valid JSON.");
    }
    if (
      !Array.isArray(parsed) ||
      parsed[0] !== "auth" ||
      typeof parsed[1] !== "string"
    ) {
      throw new Error('Auth tag must be an ["auth","…"] JSON array.');
    }
    tags.push(parsed as string[]);
  }
  return {
    kind: 22242,
    tags,
    content: "",
  };
}

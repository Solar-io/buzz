/**
 * QR pairing links carrying service addresses in fragment params.
 *
 * Format: https://origin/repos#nsec=…&relay=…&stt=…&tts=…&push=…
 * The relay param is omitted when it equals the link origin scheme-swapped to wss:.
 * Service URLs stay in the fragment and are never sent to a server.
 */

import { nsecEncode } from "nostr-tools/nip19";

export interface PairingServices {
  relayUrl: string;
  sttUrl: string;
  ttsUrl: string;
  pushGatewayUrl: string;
}

/**
 * Build a QR pairing link carrying the secret key and service addresses.
 * The relay param is omitted when it matches the derived default (wss://<link-host>).
 */
export function buildPairingLink(
  origin: string,
  secretKey: Uint8Array,
  services: PairingServices,
): string {
  const link = new URL(`${origin}/repos`);
  const nsec = nsecEncode(secretKey);

  // Fragment-only params
  const params = new URLSearchParams();
  params.append("nsec", nsec);

  // Relay param omitted only when it equals wss://<link host>
  const linkUrl = new URL(origin);
  const derivedRelay = `wss://${linkUrl.host}`;
  if (services.relayUrl !== derivedRelay) {
    params.append("relay", services.relayUrl);
  }

  // Always include stt and tts
  if (services.sttUrl) {
    params.append("stt", services.sttUrl);
  }
  if (services.ttsUrl) {
    params.append("tts", services.ttsUrl);
  }

  // Push is omitted if not configured
  if (services.pushGatewayUrl) {
    params.append("push", services.pushGatewayUrl);
  }

  // Params go in fragment, never in query
  link.hash = params.toString();
  return link.toString();
}

/**
 * Parse service URLs from a QR pairing link fragment.
 * Returns the extracted services; validation is the caller's responsibility.
 *
 * Requires the link to be https: protocol for the relay to be derivable.
 * Rejects http: and other protocols (not transferable).
 *
 * Legacy nsec-only QR codes (bare nsec1... without a link) return empty
 * services — the relay must be hand-configured.
 */
export function parsePairingServices(link: string): PairingServices {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    // Legacy nsec-only QR: link is not a valid URL; return empty services
    // The caller will handle enrolling the key separately.
    return {
      relayUrl: "",
      sttUrl: "",
      ttsUrl: "",
      pushGatewayUrl: "",
    };
  }

  // Reject non-https links (not transferable to another device)
  if (url.protocol !== "https:") {
    throw new Error(
      `Cannot derive relay address from non-https protocol: ${url.protocol}. The pairing QR must originate from an https:// origin.`,
    );
  }

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));

  // Relay: derived from link origin if omitted
  let relayUrl = hashParams.get("relay") || "";
  if (!relayUrl) {
    relayUrl = `wss://${url.host}`;
  }

  return {
    relayUrl,
    sttUrl: hashParams.get("stt") || "",
    ttsUrl: hashParams.get("tts") || "",
    pushGatewayUrl: hashParams.get("push") || "",
  };
}

/**
 * Classify the scanned connection against the current configuration.
 * Comparison uses `.host` (hostname + port), so :6351 vs :6352 is a different community.
 */
export type ConnectionClassification =
  | "first-run"
  | "same-community"
  | "community-change";

export function classifyScannedConnection(
  current: PairingServices | null,
  scanned: PairingServices,
): ConnectionClassification {
  if (!current) {
    return "first-run";
  }

  const currentHost = new URL(current.relayUrl).host;
  const scannedHost = new URL(scanned.relayUrl).host;

  if (currentHost === scannedHost) {
    return "same-community";
  }

  return "community-change";
}

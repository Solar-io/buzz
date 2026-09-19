/**
 * Apply a scanned QR connection with optional confirmation and side effects.
 *
 * Takes injected dependencies for testability:
 * - classify: determines connection type (first-run, same-community, community-change)
 * - confirm: async confirmation dialog for community-change. Returns boolean.
 * - prepare: async side effect for community-change (e.g., leave active calls, revoke push).
 * - write: persist the connection
 *
 * Ordering on community-change: confirm → prepare → write.
 * If confirm returns false, nothing is persisted and no error is thrown (user cancellation).
 * If prepare fails, nothing is written.
 *
 * On same-community and first-run: write only (no confirm, no prepare).
 */

import type {
  ConnectionClassification,
  PairingServices,
} from "./pairing-link.ts";

export type ApplyScannedConnectionResult = "applied" | "cancelled";

export interface ApplyScannedConnectionDeps {
  classify: (
    current: PairingServices | null,
    scanned: PairingServices,
  ) => ConnectionClassification;
  confirm: (
    current: PairingServices,
    scanned: PairingServices,
  ) => Promise<boolean>;
  prepare: (
    current: PairingServices,
    scanned: PairingServices,
  ) => Promise<void>;
  write: (services: PairingServices) => Promise<void>;
  validate: (services: PairingServices) => PairingServices;
}

/**
 * Apply a scanned connection with dependency injection.
 *
 * Validates the merged result BEFORE confirm and prepare — invalid input
 * throws immediately with zero side effects.
 *
 * On community-change: calls confirm. If user cancels (false), returns "cancelled"
 * with nothing written. Otherwise runs prepare, then write, returning "applied".
 *
 * On same-community or first-run: merges and writes, returning "applied".
 */
export async function applyScannedConnection(
  current: PairingServices | null,
  scanned: PairingServices,
  deps: ApplyScannedConnectionDeps,
): Promise<ApplyScannedConnectionResult> {
  // Classify the connection type
  const classification = deps.classify(current, scanned);

  // Merge: keep current values for absent scanned params
  const merged: PairingServices = {
    relayUrl: scanned.relayUrl,
    sttUrl: scanned.sttUrl || current?.sttUrl || "",
    ttsUrl: scanned.ttsUrl || current?.ttsUrl || "",
    pushGatewayUrl: scanned.pushGatewayUrl || current?.pushGatewayUrl || "",
  };

  // Validate BEFORE confirm and prepare — invalid input throws with zero side effects
  deps.validate(merged);

  // On community-change, confirm first (after the merge is ready to inspect)
  if (classification === "community-change" && current) {
    const userConfirmed = await deps.confirm(current, merged);
    if (!userConfirmed) {
      // User cancelled — nothing written, no error thrown
      return "cancelled";
    }

    // User confirmed — run the side effect, then write
    await deps.prepare(current, merged);
    await deps.write(merged);
    return "applied";
  }

  // Same-community and first-run: write only
  await deps.write(merged);
  return "applied";
}

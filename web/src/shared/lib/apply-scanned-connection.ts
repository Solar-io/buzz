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
 * Confirmation is required when ANY field changes from current, regardless
 * of relay host classification. prepare() is only called when the relay
 * host actually changes (community-change side effects).
 *
 * Flow:
 * 1. Merge scanned over current (absent scanned params keep current values)
 * 2. Validate the merged result — invalid input throws with zero side effects
 * 3. If any field changed from current: confirm, then prepare (if relay changed), then write
 * 4. If nothing changed: return "applied" without prompting or writing
 * 5. If user cancels confirm: return "cancelled" with zero writes
 */
export async function applyScannedConnection(
  current: PairingServices | null,
  scanned: PairingServices,
  deps: ApplyScannedConnectionDeps,
): Promise<ApplyScannedConnectionResult> {
  // Merge: keep current values for absent scanned params
  const merged: PairingServices = {
    relayUrl: scanned.relayUrl,
    sttUrl: scanned.sttUrl || current?.sttUrl || "",
    ttsUrl: scanned.ttsUrl || current?.ttsUrl || "",
    pushGatewayUrl: scanned.pushGatewayUrl || current?.pushGatewayUrl || "",
  };

  // Validate BEFORE confirm and prepare — invalid input throws with zero side effects
  deps.validate(merged);

  // If no current configuration, this is first-run: write without confirming
  if (!current) {
    await deps.write(merged);
    return "applied";
  }

  // Check if ANY field changed from current
  const relayChanged = current.relayUrl !== merged.relayUrl;
  const sttChanged = current.sttUrl !== merged.sttUrl;
  const ttsChanged = current.ttsUrl !== merged.ttsUrl;
  const pushChanged = current.pushGatewayUrl !== merged.pushGatewayUrl;
  const anyFieldChanged =
    relayChanged || sttChanged || ttsChanged || pushChanged;

  // If nothing changed, return without writing or prompting
  if (!anyFieldChanged) {
    return "applied";
  }

  // Something changed — confirm with the user
  const userConfirmed = await deps.confirm(current, merged);
  if (!userConfirmed) {
    // User cancelled — nothing written, no error thrown
    return "cancelled";
  }

  // User confirmed — if the relay host changed, run the side effect (prepare)
  if (relayChanged) {
    await deps.prepare(current, merged);
  }

  // Write the merged configuration
  await deps.write(merged);
  return "applied";
}

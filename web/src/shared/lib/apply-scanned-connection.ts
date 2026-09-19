/**
 * Apply a scanned QR connection with optional confirmation and side effects.
 *
 * Validates the merged result BEFORE confirm and prepare — invalid input
 * throws immediately with zero side effects.
 *
 * Confirmation is required when ANY field changes from current, regardless
 * of whether the relay host is the same. prepare() is only called when the
 * relay URL (full string) actually changes (community-change side effects).
 *
 * Flow:
 * 1. Merge scanned over current (absent scanned params keep current values)
 * 2. Validate the merged result — invalid input throws with zero side effects
 * 3. If all fields are empty after merge (legacy bare nsec QR): return "applied" without writing
 * 4. If any field changed from current: confirm, then prepare (if relay changed), then write
 * 5. If nothing changed: return "applied" without prompting or writing
 * 6. If user cancels confirm: return "cancelled" with zero writes
 */

import type { PairingServices } from "./pairing-link.ts";

export type ApplyScannedConnectionResult = "applied" | "cancelled";

export interface ApplyScannedConnectionDeps {
  confirm: (
    current: PairingServices,
    merged: PairingServices,
  ) => Promise<boolean>;
  prepare: (
    current: PairingServices,
    merged: PairingServices,
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
 * URL (full string) actually changes (community-change side effects).
 *
 * Flow:
 * 1. Merge scanned over current (absent scanned params keep current values)
 * 2. Validate the merged result — invalid input throws with zero side effects
 * 3. If all fields are empty after merge (legacy bare nsec QR): return "applied" without writing
 * 4. If any field changed from current: confirm, then prepare (if relay changed), then write
 * 5. If nothing changed: return "applied" without prompting or writing
 * 6. If user cancels confirm: return "cancelled" with zero writes
 */
export async function applyScannedConnection(
  current: PairingServices | null,
  scanned: PairingServices,
  deps: ApplyScannedConnectionDeps,
): Promise<ApplyScannedConnectionResult> {
  // Legacy bare nsec QR (all-empty scanned): no-op, don't validate or write
  // This must be checked BEFORE merge and validate to avoid throwing on empty relay
  const isAllEmpty =
    !scanned.relayUrl &&
    !scanned.sttUrl &&
    !scanned.ttsUrl &&
    !scanned.pushGatewayUrl;
  if (isAllEmpty) {
    return "applied";
  }

  // Merge: keep current values for absent scanned params
  const merged: PairingServices = {
    relayUrl: scanned.relayUrl || current?.relayUrl || "",
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

  // User confirmed — if the relay URL changed, run the side effect (prepare)
  if (relayChanged) {
    await deps.prepare(current, merged);
  }

  // Write the merged configuration
  await deps.write(merged);
  return "applied";
}

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
}

/**
 * Apply a scanned connection with dependency injection.
 *
 * On community-change: calls confirm first. If user cancels (false), returns silently
 * with nothing written. Otherwise runs prepare, then write.
 *
 * On same-community or first-run: writes immediately (no confirm, no prepare).
 */
export async function applyScannedConnection(
  current: PairingServices | null,
  scanned: PairingServices,
  deps: ApplyScannedConnectionDeps,
): Promise<void> {
  // Classify the connection type
  const classification = deps.classify(current, scanned);

  // On community-change, confirm first
  if (classification === "community-change" && current) {
    const userConfirmed = await deps.confirm(current, scanned);
    if (!userConfirmed) {
      // User cancelled — nothing written, no error thrown
      return;
    }

    // User confirmed — run the side effect, then write
    await deps.prepare(current, scanned);
    await deps.write(scanned);
    return;
  }

  // Same-community and first-run: write only
  await deps.write(scanned);
}

/**
 * Apply a scanned QR connection with optional confirmation flow.
 *
 * Takes injected dependencies for testability:
 * - classify: determines connection type (first-run, same-community, community-change)
 * - prepare: async side effect for community-change (e.g., confirm + cleanup)
 * - write: persist the connection
 *
 * Ordering: write first, then prepare (if needed). If prepare fails, the device
 * still has a working address.
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
  prepare: (
    current: PairingServices,
    scanned: PairingServices,
  ) => Promise<void>;
  write: (services: PairingServices) => Promise<void>;
}

/**
 * Apply a scanned connection with dependency injection.
 *
 * On community-change: validates, then writes services first, then calls prepare.
 * On same-community: validates, writes immediately.
 * On first-run: validates, writes immediately.
 *
 * Throws if validation fails.
 */
export async function applyScannedConnection(
  current: PairingServices | null,
  scanned: PairingServices,
  deps: ApplyScannedConnectionDeps,
): Promise<void> {
  // Classify immediately
  const classification = deps.classify(current, scanned);

  // Write first (unconditional)
  await deps.write(scanned);

  // Prepare only on community-change (after write succeeds)
  if (classification === "community-change" && current) {
    await deps.prepare(current, scanned);
  }
}

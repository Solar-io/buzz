import type { DesktopCatalog } from "./desktopCatalog";

/**
 * Capability gate for the Phase-2 admin controls (avatar/timeout/start-on-
 * launch edit, effort set/clear, restart). The kind-30180 catalog `version`
 * is the signal: a desktop publishing >= CONTROLS_CATALOG_VERSION applies the
 * extended update fields, envVarsPatch, and restart; an older desktop parses
 * the new update fields but silently drops them at the applier (the exact
 * Phase-1 failure mode), so the controls must not render against it.
 */

export const CONTROLS_CATALOG_VERSION = 2;

function catalogVersionFor(
  catalogs: readonly DesktopCatalog[],
  machine: string,
): number {
  return catalogs.find((catalog) => catalog.machine === machine)?.version ?? 0;
}

/**
 * Edit-panel gate: render the Phase-2 controls iff the agent has at least one
 * claiming machine AND EVERY claiming machine's catalog is >= v2. All-v2, not
 * exactly-one-v2: with machines {A(v2), B(v1)} an update broadcast would apply
 * on A while silently no-oping on B — the divergence the gate exists to
 * prevent. A claiming machine with no parsed catalog counts as not-v2. Zero
 * claiming machines → hide (the panel already says "No desktop reports this
 * agent").
 */
export function controlsEnabled(
  catalogs: readonly DesktopCatalog[],
  machines: readonly string[],
): boolean {
  if (machines.length === 0) {
    return false;
  }
  return machines.every(
    (machine) =>
      catalogVersionFor(catalogs, machine) >= CONTROLS_CATALOG_VERSION,
  );
}

/**
 * Create-form gate: the effective target machine (the selected `applyOn`
 * when >= 2 catalogs, the single catalog when 1, none when 0) must be v2.
 */
export function createControlsEnabled(
  catalogs: readonly DesktopCatalog[],
  targetMachine: string | null,
): boolean {
  if (targetMachine === null) {
    return false;
  }
  return catalogVersionFor(catalogs, targetMachine) >= CONTROLS_CATALOG_VERSION;
}

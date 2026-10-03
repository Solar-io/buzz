import type { DesktopCatalog } from "./desktopCatalog";

/** Named capabilities are authoritative only on catalog v5 and later. */
export function hasCap(
  catalog: DesktopCatalog | null | undefined,
  cap: string,
): boolean {
  return (
    !!catalog && catalog.version >= 5 && (catalog.caps ?? []).includes(cap)
  );
}

/** Intersection: every desktop claiming an agent must support the operation. */
export function capsFor(
  catalogs: readonly DesktopCatalog[],
  agent: { machines: readonly string[] },
): string[] {
  if (agent.machines.length === 0) return [];
  const first = catalogs.find(
    (catalog) => catalog.machine === agent.machines[0],
  );
  return (first?.caps ?? []).filter((cap) =>
    agent.machines.every((machine) =>
      hasCap(
        catalogs.find((catalog) => catalog.machine === machine),
        cap,
      ),
    ),
  );
}

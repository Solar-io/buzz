import type { AdminAckEnvelope } from "./adminCommands";
import type { DesktopCatalog } from "./desktopCatalog";
import { hasCap } from "./desktopCaps";

export interface DesktopPresence {
  status: "unknown" | "checking" | "online" | "offline";
  lastSeen: number | null;
  missed: number;
}

/** Mounted-view monitor. Catalog publication alone never proves liveness. */
export function monitorDesktopPresence(
  catalogs: readonly DesktopCatalog[],
  ping: (
    machine: string,
    signal: AbortSignal,
  ) => Promise<AdminAckEnvelope | null>,
  changed: (state: ReadonlyMap<string, DesktopPresence>) => void,
) {
  const state = new Map<string, DesktopPresence>();
  const inFlight = new Map<string, AbortController>();
  let stopped = false;
  for (const catalog of catalogs) {
    state.set(catalog.machine, {
      status: hasCap(catalog, "ping") ? "checking" : "unknown",
      lastSeen: null,
      missed: 0,
    });
  }
  const publish = () => {
    if (!stopped) changed(new Map(state));
  };
  const probe = (catalog: DesktopCatalog) => {
    if (stopped || !hasCap(catalog, "ping") || inFlight.has(catalog.machine))
      return;
    const controller = new AbortController();
    inFlight.set(catalog.machine, controller);
    let settled = false;
    const finish = (ack: AdminAckEnvelope | null) => {
      if (settled || stopped) return;
      settled = true;
      clearTimeout(deadline);
      inFlight.delete(catalog.machine);
      controller.abort();
      const previous = state.get(catalog.machine);
      if (!previous) return;
      const answered =
        ack?.ok === true &&
        ack.result?.machine === catalog.machine &&
        typeof ack.result?.catalogVersion === "number" &&
        ack.result.catalogVersion >= 5 &&
        Array.isArray(ack.result.caps) &&
        ack.result.caps.includes("ping");
      const missed = answered ? 0 : previous.missed + 1;
      state.set(
        catalog.machine,
        answered
          ? { status: "online", lastSeen: Date.now(), missed: 0 }
          : {
              ...previous,
              missed,
              status: missed >= 2 ? "offline" : previous.status,
            },
      );
      publish();
    };
    const deadline = setTimeout(() => finish(null), 10_000);
    controller.signal.addEventListener("abort", () => clearTimeout(deadline), {
      once: true,
    });
    void ping(catalog.machine, controller.signal)
      .then(finish)
      .catch(() => finish(null));
  };
  const focus = () => {
    for (const catalog of catalogs) probe(catalog);
  };
  publish();
  focus();
  const interval = setInterval(focus, 30_000);
  return {
    focus,
    stop() {
      stopped = true;
      clearInterval(interval);
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    },
  };
}

/** Shared by existing controls and the future W7 setting controls. */
export function desktopControlLock(
  catalogs: readonly DesktopCatalog[],
  presence: ReadonlyMap<string, DesktopPresence>,
  machines: readonly string[],
  cap?: string,
): { locked: boolean; offline: boolean; reason: string | null } {
  if (machines.length === 0)
    return { locked: true, offline: false, reason: "Needs the desktop" };
  const offline = machines.some(
    (machine) =>
      catalogs.some(
        (catalog) => catalog.machine === machine && catalog.version >= 5,
      ) && presence.get(machine)?.status === "offline",
  );
  for (const machine of machines) {
    const catalog = catalogs.find((entry) => entry.machine === machine);
    const host = machine.replace(/\.local$/, "");
    // v2-v4 cannot ping. Preserve the shipped legacy controls; only named
    // v5 requirements lock them. A historical report never implies online.
    if (!cap && catalog && catalog.version >= 2 && catalog.version < 5)
      continue;
    if (!hasCap(catalog, cap ?? "ping"))
      return {
        locked: true,
        offline,
        reason: `Update Buzz Desktop on ${host} to change this`,
      };
  }
  if (
    machines.some(
      (machine) =>
        catalogs.some(
          (catalog) => catalog.machine === machine && catalog.version >= 5,
        ) && presence.get(machine)?.status !== "online",
    )
  )
    return {
      locked: true,
      offline,
      reason: offline ? "Needs the desktop" : "Connecting to Buzz Desktop…",
    };
  return { locked: false, offline: false, reason: null };
}

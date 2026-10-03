import type { AdminCommand } from "./adminCommands";
import type { AdminSendOptions } from "./admin/protocolV5";
import type { DesktopCatalog } from "./desktopCatalog";
import { desktopControlLock, type DesktopPresence } from "./desktopPresence";

/** Fail closed before signing or queueing a command; broadcasts check all targets. */
export function adminCommandLock(
  command: AdminCommand,
  options: AdminSendOptions | undefined,
  catalogs: readonly DesktopCatalog[],
  presence: ReadonlyMap<string, DesktopPresence>,
) {
  const pubkey = "pubkey" in command.request ? command.request.pubkey : null;
  const machines = options?.target
    ? [options.target]
    : catalogs
        // Stale registrations have no claiming machine. Their unregister
        // broadcast still checks every receiving desktop's presence.
        .filter(
          (catalog) =>
            command.action === "unregister" ||
            !pubkey ||
            catalog.agents.includes(pubkey),
        )
        .map((catalog) => catalog.machine);
  for (const cap of options?.requires ?? []) {
    const lock = desktopControlLock(catalogs, presence, machines, cap);
    if (lock.locked) return lock;
  }
  return desktopControlLock(
    catalogs,
    presence,
    machines,
    command.action === "ping" ? "ping" : undefined,
  );
}

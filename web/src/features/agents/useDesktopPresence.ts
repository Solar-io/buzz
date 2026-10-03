import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { requestAdminCommand } from "./lib/admin/request";
import type { DesktopCatalog } from "./lib/desktopCatalog";
import {
  desktopControlLock,
  monitorDesktopPresence,
  type DesktopPresence,
} from "./lib/desktopPresence";

/** Pings only while the owning Agents view is mounted, and on window focus. */
export function useDesktopPresence(catalogs: readonly DesktopCatalog[]) {
  const { session, status } = useRelaySession();
  const [byMachine, setByMachine] = useState<
    ReadonlyMap<string, DesktopPresence>
  >(() => new Map());
  // useDesktopCatalogs returns a fresh array. Publication timestamps must not
  // reset a machine's missed-ping streak or its last successful response.
  const catalogKey = JSON.stringify(
    catalogs.map(({ machine, version, caps }) => ({ machine, version, caps })),
  );
  useEffect(() => {
    if (!session || status !== "open") {
      setByMachine(new Map());
      return;
    }
    const targets = JSON.parse(catalogKey) as DesktopCatalog[];
    const monitor = monitorDesktopPresence(
      targets,
      (machine, signal) =>
        requestAdminCommand(
          session,
          { action: "ping", request: {} },
          { target: machine, requires: ["ping"] },
          10_000,
          signal,
        ),
      setByMachine,
    );
    window.addEventListener("focus", monitor.focus);
    return () => {
      window.removeEventListener("focus", monitor.focus);
      monitor.stop();
    };
  }, [session, status, catalogKey]);
  return {
    byMachine,
    lock: (machines: readonly string[], cap?: string) =>
      desktopControlLock(catalogs, byMachine, machines, cap),
  };
}

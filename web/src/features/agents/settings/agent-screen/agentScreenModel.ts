import type { DesktopCatalog } from "../../lib/desktopCatalog";
import type { RosterRow } from "../../lib/roster";
import type { ObserverFrame } from "../../lib/observerEvents";
import { activeTurns } from "@/features/work/lib/activeTurns";

export type AgentTab = "settings" | "channels" | "logs" | "memory" | "activity";

/** Previous/next follows the roster's order, without wrapping at its edges. */
export function rosterPosition(
  roster: readonly Pick<RosterRow, "pubkey">[],
  pubkey: string,
) {
  const index = roster.findIndex((row) => row.pubkey === pubkey);
  return {
    position: index < 0 ? 0 : index + 1,
    total: roster.length,
    previous: index > 0 ? roster[index - 1].pubkey : null,
    next: index >= 0 ? (roster[index + 1]?.pubkey ?? null) : null,
  };
}

/** Only the matching desktop's historical report can enable its controls. */
export function agentDesktopReady(
  catalogs: readonly DesktopCatalog[],
  machines: readonly string[],
  nowS: number,
) {
  return (
    machines.length === 1 &&
    catalogs.some(
      (catalog) =>
        catalog.machine === machines[0] &&
        catalog.updatedAt <= nowS + 300 &&
        nowS - catalog.updatedAt <= 6 * 3600 + 300,
    )
  );
}

/** Derive working state per turn, so a terminal frame actually ends it. */
export function agentNow(
  pubkey: string,
  frames: readonly ObserverFrame[],
  nowS: number,
) {
  const turns = activeTurns(new Map([[pubkey, frames]]), nowS);
  const lastFinished =
    frames
      .filter(
        (frame) =>
          frame.kind === "turn_completed" || frame.kind === "turn_error",
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  return { turns, lastFinished };
}

/** Logs remains a capability-locked surface until the S2 read path ships. */
export function logsLockCopy(machine?: string) {
  return `Update Buzz Desktop${machine ? ` on ${machine.replace(/\.local$/, "")}` : ""} to view logs here.`;
}

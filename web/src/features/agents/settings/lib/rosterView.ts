import type { DesktopCatalog } from "../../lib/desktopCatalog";
import type { ObserverFrame } from "../../lib/observerEvents";
import { agentRecentlyActive } from "../../lib/observerEvents.ts";
import type { RosterRow } from "../../lib/roster";
import { findStaleAgents } from "../../lib/staleAgents.ts";

export type RosterStatus = "Working" | "Claimed" | "Not on any desktop";
export type RosterFilter = "All" | RosterStatus;
export interface RosterViewRow extends RosterRow {
  teams: string[];
  status: RosterStatus;
  staleReason?: string;
}

/** Recent observer evidence, excluding channels whose latest turn ended. */
export function rosterWorking(frames: ObserverFrame[], now: number): boolean {
  const latest = new Map<string | null, ObserverFrame>();
  for (const frame of frames) {
    const previous = latest.get(frame.channelId);
    if (
      !previous ||
      frame.createdAt > previous.createdAt ||
      (frame.createdAt === previous.createdAt && frame.seq > previous.seq)
    ) {
      latest.set(frame.channelId, frame);
    }
  }
  return agentRecentlyActive(
    [...latest.values()].filter(
      (frame) =>
        !["turn_completed", "turn_error", "agent_panic"].includes(frame.kind),
    ),
    now,
  );
}

/** The stale filter shares the existing detector exactly, including duplicates. */
export function buildRosterView(
  roster: readonly RosterRow[],
  catalogs: readonly DesktopCatalog[],
  teamNames: ReadonlyMap<string, string[]>,
  frames: ReadonlyMap<string, ObserverFrame[]> = new Map(),
  now = Math.floor(Date.now() / 1000),
): RosterViewRow[] {
  const stale = new Map(
    findStaleAgents(
      roster.map((row) => row.entry),
      [...catalogs],
    ).map((row) => [row.pubkey, row.reason]),
  );
  return roster.map((row) => ({
    ...row,
    teams: row.entry.personaId
      ? (teamNames.get(row.entry.personaId) ?? [])
      : [],
    status: rosterWorking(frames.get(row.pubkey) ?? [], now)
      ? "Working"
      : row.machines.length > 0
        ? "Claimed"
        : "Not on any desktop",
    staleReason: stale.get(row.pubkey),
  }));
}

/** Counts describe the whole roster, independent of the currently selected chip. */
export function rosterCounts(
  rows: readonly RosterViewRow[],
): Record<RosterFilter, number> {
  return {
    All: rows.length,
    Working: rows.filter((row) => row.status === "Working").length,
    Claimed: rows.filter((row) => row.status === "Claimed").length,
    "Not on any desktop": rows.filter((row) => row.staleReason !== undefined)
      .length,
  };
}

/** Name/model search and exact team membership compose with every status chip. */
export function filterRoster(
  rows: readonly RosterViewRow[],
  status: RosterFilter,
  team: string,
  query: string,
): RosterViewRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (status === "All" ||
        (status === "Not on any desktop"
          ? row.staleReason !== undefined
          : row.status === status)) &&
      (!team || row.teams.includes(team)) &&
      `${row.name} ${row.model}`.toLocaleLowerCase().includes(needle),
  );
}

/** Breakpoints refer to the roster's content box, never the browser viewport. */
export function rosterColumns(width: number): string[] {
  return width < 768
    ? ["Agent", "Status", "Model"]
    : [
        "Agent",
        "Status",
        "Model",
        "Effort",
        "Voice turns",
        ...(width >= 1100 ? ["Runtime", "Acct"] : []),
      ];
}

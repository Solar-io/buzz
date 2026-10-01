/**
 * herdr's projection → what the Terminal chrome draws (Terminal artboard:
 * Spaces, Agents grouped by space, the focused space's tabs). Pure.
 *
 * Read-only by design: herdr 0.7.4 focus is SERVER-GLOBAL (hatch S0 spike),
 * so a click here would move Sam's CLI view of the same session. Nothing in
 * this view model is an action.
 */

import type { AgentStatus, HerdrSnapshot } from "./hatchClient.ts";

export type StatusTone = "work" | "need" | "done" | "idle";

export function statusTone(status: AgentStatus): StatusTone {
  switch (status) {
    case "working":
      return "work";
    case "blocked":
      return "need";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/** The words under an agent row; null when herdr knows nothing worth saying. */
export function statusLabel(status: AgentStatus): string | null {
  switch (status) {
    case "working":
      return "working";
    case "blocked":
      return "waiting on you";
    case "done":
      return "done";
    case "idle":
      return "idle";
    default:
      return null;
  }
}

/** Needs-you first, then running, then finished, then quiet. */
const PRIORITY: Record<StatusTone, number> = {
  need: 0,
  work: 1,
  done: 2,
  idle: 3,
};

export interface SpaceRow {
  id: string;
  label: string;
  focused: boolean;
  tone: StatusTone;
}

export interface AgentRow {
  id: string;
  space: string;
  title: string;
  meta: string;
  tone: StatusTone;
}

export interface TabChip {
  id: string;
  label: string;
  focused: boolean;
  tone: StatusTone;
}

export interface HerdrView {
  spaces: SpaceRow[];
  agents: AgentRow[];
  /** Tabs of the focused space (or the first space when herdr reports none focused). */
  tabs: TabChip[];
  focusedSpace: string | null;
  tabCount: number;
}

const byNumber = <T extends { number: number | null }>(a: T, b: T) =>
  (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);

export function herdrView(snapshot: HerdrSnapshot): HerdrView {
  const workspaces = [...snapshot.workspaces].sort(byNumber);
  const order = new Map(workspaces.map((w, index) => [w.id, index]));
  const spaceLabel = new Map(workspaces.map((w) => [w.id, w.label]));
  const tabLabel = new Map(snapshot.tabs.map((t) => [t.id, t.label]));
  const focused = workspaces.find((w) => w.focused) ?? workspaces[0] ?? null;

  const agents = snapshot.agents
    .map((a) => {
      const tone = statusTone(a.status);
      const kind = a.agent ?? "agent";
      const label = a.label;
      const title =
        a.agent && label.toLowerCase() === a.agent.toLowerCase()
          ? (tabLabel.get(a.tabId) ?? label)
          : label;
      const words = statusLabel(a.status);
      return {
        row: {
          id: a.id,
          space: spaceLabel.get(a.workspaceId) ?? a.workspaceId,
          title,
          meta: words ? `${kind} · ${words}` : kind,
          tone,
        },
        order: order.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .sort(
      (a, b) =>
        a.order - b.order || PRIORITY[a.row.tone] - PRIORITY[b.row.tone],
    )
    .map((entry) => entry.row);

  return {
    spaces: workspaces.map((w) => ({
      id: w.id,
      label: w.label,
      focused: w.id === focused?.id,
      tone: statusTone(w.status),
    })),
    agents,
    tabs: focused
      ? snapshot.tabs
          .filter((t) => t.workspaceId === focused.id)
          .sort(byNumber)
          .map((t) => ({
            id: t.id,
            label: t.label,
            focused: t.focused,
            tone: statusTone(t.status),
          }))
      : [],
    focusedSpace: focused?.label ?? null,
    tabCount: snapshot.tabs.length,
  };
}

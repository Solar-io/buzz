import type { NeedRow } from "./workTypes.ts";

/**
 * Should a new Needs-you row raise a toast? (`useWorkToasts`)
 *
 * Only a decision (an approval or an ask) that ARRIVED after the feed
 * settled, while no Work surface is on screen — and never for the
 * conversation the reader already has open: the row is on the page in front
 * of them, and on a phone the sticky toast sat over that very conversation
 * (Phase 2 QA, 2026-09-30). The agent-done toast has had the same rule since
 * Phase 1.
 */
export function shouldToastNeed(
  row: Pick<NeedRow, "kind" | "channelId">,
  state: { settled: boolean; workVisible: boolean; selectedId: string | null },
): boolean {
  if (!state.settled || state.workVisible) {
    return false;
  }
  if (row.kind !== "approval" && row.kind !== "ask") {
    return false;
  }
  return row.channelId === null || row.channelId !== state.selectedId;
}

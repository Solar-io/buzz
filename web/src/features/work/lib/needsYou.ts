/**
 * Needs you: four sources merged into one sorted list (phase-1 §2.1–2.3).
 *
 *   1. asks      — `useAsks().interviews` (unanswered decision cards); a
 *                  card that references a pull request is an APPROVAL
 *                  (Phase 8, `prAsk.ts`)
 *   2. mentions  — the asks feed folded by `buildInboxItems`: unread mention
 *                  conversations, not DMs, and never a card (a card is 1)
 *   3. approvals — workflow 46010s with no outcome (approvalEvents.ts)
 *   4. feedback  — every pending NIP-ER reminder
 *
 * DMs are not rows: agent DMs are conversational volume and the Inbox keeps
 * them. The header count is the scoped row count, so a badge can never count
 * something the list cannot show (the inboxFilter.ts 2026-09-17 complaint).
 */

import type { AskInterview } from "@/features/home/lib/askInterview.ts";
import type { InboxItem } from "@/features/home/lib/inboxItem.ts";
import { reminderDestination } from "@/features/reminders/lib/reminderNavigation.ts";
import type { Reminder } from "@/features/reminders/lib/reminderTypes.ts";
import type { PendingApproval } from "./approvalEvents.ts";
import { prReference } from "./prAsk.ts";
import type {
  NeedChipFilter,
  NeedCounts,
  NeedRow,
  WorkScope,
} from "./workTypes.ts";

export interface NeedInputs {
  interviews: readonly AskInterview[];
  /** `buildInboxItems` over the asks feed (cards included — see mentionRows). */
  inboxItems: readonly InboxItem[];
  approvals: readonly PendingApproval[];
  reminders: readonly Reminder[];
}

/** Approvals expiring within this window pin to the top. */
const EXPIRY_PIN_S = 3_600;
const TITLE_MAX = 140;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TITLE_MAX
    ? flat
    : `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Asks — and PR-merge asks (Phase 8): a card that references a pull request
 * is an APPROVAL under the Approvals chip. It stays an ask underneath (its
 * source, and so its actions, are the card's own options), because the
 * answer IS the merge decision the agent acts on.
 */
function askRows(interviews: readonly AskInterview[]): NeedRow[] {
  return interviews.map((interview) => {
    const ask = interview.ask;
    const pr = prReference(ask.card);
    return {
      key: `ask:${ask.id}`,
      kind: pr ? "approval" : "ask",
      chip: pr ? "approvals" : "asks",
      channelId: ask.channelId,
      actorPubkey: ask.authorPubkey,
      title: clip(ask.card.title) || (pr ? "Merge request" : "Decision"),
      at: ask.createdAt,
      expiresAt: null,
      overdueBy: null,
      open: { channelId: ask.channelId, messageId: ask.id },
      source: { kind: "ask", interview },
      pr,
    };
  });
}

function mentionRows(items: readonly InboxItem[]): NeedRow[] {
  const rows: NeedRow[] = [];
  for (const item of items) {
    if (
      !item.categories.includes("mention") ||
      item.categories.includes("dm") ||
      item.unreadCount <= 0 ||
      // A card that p-tags me is an ASK row (source 1), never also a mention.
      item.message.card
    ) {
      continue;
    }
    rows.push({
      key: `mention:${item.conversationId}`,
      kind: "mention",
      chip: "asks",
      channelId: item.channelId,
      actorPubkey: item.message.authorPubkey,
      title: clip(item.message.content) || "Mentioned you",
      at: item.latestActivityAt,
      expiresAt: null,
      overdueBy: null,
      open: { channelId: item.channelId, messageId: item.message.id },
      source: { kind: "mention", item },
    });
  }
  return rows;
}

function approvalRows(approvals: readonly PendingApproval[]): NeedRow[] {
  return approvals.map((approval) => ({
    key: `approval:${approval.ref}`,
    kind: "approval",
    chip: "approvals",
    channelId: approval.channelId,
    actorPubkey: null,
    title: clip(approval.text) || "Workflow approval",
    at: approval.createdAt,
    expiresAt: approval.expiresAt,
    overdueBy: null,
    open: { view: "workflows" },
    source: { kind: "approval", approval },
  }));
}

function feedbackRows(reminders: readonly Reminder[], nowS: number): NeedRow[] {
  const rows: NeedRow[] = [];
  for (const reminder of reminders) {
    if (reminder.content.status !== "pending") {
      continue;
    }
    const target = reminder.content.target;
    const due = reminder.notBefore ?? reminder.createdAt;
    const channelId = target?.channelId ? target.channelId : null;
    rows.push({
      key: `feedback:${reminder.id}`,
      kind: "feedback",
      chip: "feedback",
      channelId,
      actorPubkey: target?.authorPubkey ? target.authorPubkey : null,
      title:
        clip(reminder.content.note ?? "") ||
        clip(target?.preview ?? "") ||
        "Reminder",
      at: due,
      expiresAt: null,
      overdueBy: nowS > due ? nowS - due : null,
      open: reminderDestination(target) ?? { view: "reminders" },
      source: { kind: "feedback", reminder },
    });
  }
  return rows;
}

/** Every row from every source, unsorted and unscoped. */
export function buildNeeds(inputs: NeedInputs, nowS: number): NeedRow[] {
  return [
    ...askRows(inputs.interviews),
    ...mentionRows(inputs.inboxItems),
    ...approvalRows(inputs.approvals),
    ...feedbackRows(inputs.reminders, nowS),
  ];
}

const RANK: Record<NeedRow["kind"], number> = {
  approval: 0,
  ask: 0,
  mention: 1,
  feedback: 2,
};

function expiringSoon(row: NeedRow, nowS: number): boolean {
  return (
    row.kind === "approval" &&
    row.expiresAt !== null &&
    row.expiresAt - nowS <= EXPIRY_PIN_S
  );
}

/**
 * Total, stable order (§2.2):
 *   1. approvals expiring within the hour, soonest first;
 *   2. then rank: approval = ask, mention, feedback;
 *   3. blocking rows and mentions newest first;
 *   4. feedback overdue first (most overdue first), then upcoming soonest;
 *   5. key ascending.
 */
export function sortNeeds(rows: readonly NeedRow[], nowS: number): NeedRow[] {
  return [...rows].sort((a, b) => {
    const pinA = expiringSoon(a, nowS);
    const pinB = expiringSoon(b, nowS);
    if (pinA !== pinB) {
      return pinA ? -1 : 1;
    }
    if (pinA && pinB) {
      const byExpiry = (a.expiresAt ?? 0) - (b.expiresAt ?? 0);
      if (byExpiry !== 0) {
        return byExpiry;
      }
    }
    const byRank = RANK[a.kind] - RANK[b.kind];
    if (byRank !== 0) {
      return byRank;
    }
    if (a.kind === "feedback" && b.kind === "feedback") {
      const overA = (a.overdueBy ?? 0) > 0;
      const overB = (b.overdueBy ?? 0) > 0;
      if (overA !== overB) {
        return overA ? -1 : 1;
      }
      const byDue = overA
        ? (b.overdueBy ?? 0) - (a.overdueBy ?? 0)
        : a.at - b.at;
      if (byDue !== 0) {
        return byDue;
      }
    } else if (b.at !== a.at) {
      return b.at - a.at;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** "This channel" keeps the open channel's rows; channel-less rows are Everywhere-only. */
export function scopeNeeds(
  rows: readonly NeedRow[],
  scope: WorkScope,
  channelId: string | null,
): NeedRow[] {
  if (scope !== "channel" || !channelId) {
    return [...rows];
  }
  return rows.filter(
    (row) => row.channelId !== null && row.channelId === channelId,
  );
}

/** Counts over the SCOPED rows — the header badge equals the All list. */
export function needCounts(rows: readonly NeedRow[]): NeedCounts {
  const counts: NeedCounts = {
    all: rows.length,
    approvals: 0,
    asks: 0,
    feedback: 0,
    overdue: 0,
  };
  for (const row of rows) {
    counts[row.chip] += 1;
    if (row.kind === "feedback" && (row.overdueBy ?? 0) > 0) {
      counts.overdue += 1;
    }
  }
  return counts;
}

/**
 * The one composition the feed uses: scope, then count the SCOPED rows, then
 * sort. Counting before scoping is the bug this exists to rule out — a badge
 * of 8 over a list of 3.
 */
export function scopedNeeds(
  rows: readonly NeedRow[],
  scope: WorkScope,
  channelId: string | null,
  nowS: number,
): { needs: NeedRow[]; counts: NeedCounts } {
  const scoped = scopeNeeds(rows, scope, channelId);
  return { needs: sortNeeds(scoped, nowS), counts: needCounts(scoped) };
}

/** Chips filter the list only — never the counts. */
export function filterByChip(
  rows: readonly NeedRow[],
  chip: NeedChipFilter,
): NeedRow[] {
  return chip === "all" ? [...rows] : rows.filter((row) => row.chip === chip);
}

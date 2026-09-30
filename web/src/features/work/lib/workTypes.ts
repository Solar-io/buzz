/**
 * Work tab data model (phase-1 §2). One pure join (`workFeed.ts`) produces a
 * `WorkFeed`; nothing under `ui/` derives data.
 */

import type { AskInterview } from "@/features/home/lib/askInterview.ts";
import type { InboxItem } from "@/features/home/lib/inboxItem.ts";
import type { Reminder } from "@/features/reminders/lib/reminderTypes.ts";
import type { PendingApproval } from "./approvalEvents.ts";

export type WorkScope = "everywhere" | "channel";

export type NeedKind = "approval" | "ask" | "mention" | "feedback";
export type NeedChip = "approvals" | "asks" | "feedback";
export type NeedChipFilter = "all" | NeedChip;

/** The object a row was built from — the row's actions read it. */
export type NeedSource =
  | { kind: "ask"; interview: AskInterview }
  | { kind: "mention"; item: InboxItem }
  | { kind: "approval"; approval: PendingApproval }
  | { kind: "feedback"; reminder: Reminder };

/** Where a row's Open goes: a message, or a full-page view. */
export type NeedOpen =
  | { channelId: string; messageId: string }
  | { view: "reminders" | "workflows" };

export interface NeedRow {
  /** "ask:<cardId>" | "mention:<conversationId>" | "approval:<ref>" | "feedback:<d>" */
  key: string;
  kind: NeedKind;
  chip: NeedChip;
  /** Null only for note-only feedback and channel-less approvals. */
  channelId: string | null;
  /** Who is asking; null for relay-authored approvals and note-only feedback. */
  actorPubkey: string | null;
  /** Card title | message preview | approval text | reminder note/preview. */
  title: string;
  /** Unix seconds: createdAt, or notBefore for feedback. */
  at: number;
  /** Approvals only, when known. */
  expiresAt: number | null;
  /** Feedback only: now − notBefore when positive. */
  overdueBy: number | null;
  open: NeedOpen | null;
  source: NeedSource;
}

export interface NeedCounts {
  all: number;
  approvals: number;
  asks: number;
  feedback: number;
  overdue: number;
}

export type RunRowState = "live" | "stalled" | "lost" | "reacting";

export interface RunRow {
  key: string;
  agentPubkey: string;
  turnId: string | null;
  channelId: string | null;
  startedAt: number | null;
  lastBeatAt: number | null;
  state: RunRowState;
  source: "observer" | "reaction";
}

export interface QueuedRow {
  key: string;
  agentPubkey: string;
  /** The event the agent reacted 👀 to. */
  eventId: string;
  /** Null until the target event has been fetched. */
  channelId: string | null;
  /** When the 👀 landed (unix s). */
  at: number;
}

export interface DoneLast {
  agentPubkey: string;
  channelId: string | null;
  at: number;
  stopReason: string | null;
}

export interface DoneSummary {
  state: "ready";
  /** Distinct turns finished since local midnight. */
  count: number;
  /** Events that did not decrypt — never counted as done. */
  locked: number;
  last: DoneLast | null;
}

export type DoneState =
  | DoneSummary
  | { state: "loading" }
  | { state: "locked" }
  | { state: "unavailable" };

export interface WorkFeed {
  /** Sorted and scope-filtered — NOT chip-filtered. */
  needs: NeedRow[];
  needCounts: NeedCounts;
  /** Live first, then stalled/lost, then reaction-derived. */
  running: RunRow[];
  /** Oldest first ("next" = queued[0]). */
  queued: QueuedRow[];
  done: DoneState;
}

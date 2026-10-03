/**
 * Work tab data model (phase-1 §2). One pure join (`workFeed.ts`) produces a
 * `WorkFeed`; nothing under `ui/` derives data.
 */

import type { AskInterview } from "@/features/home/lib/askInterview.ts";
import type { InboxItem } from "@/features/home/lib/inboxItem.ts";
import type { Reminder } from "@/features/reminders/lib/reminderTypes.ts";
import type { PendingApproval } from "./approvalEvents.ts";
import type { PrReference } from "./prAsk.ts";
import type { TaskProgress } from "./taskStatus.ts";

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
  /**
   * A PR-merge ask (Phase 8): a decision card that references a NIP-34 pull
   * request (kind 1618). It lists as APPROVAL; its actions are the card's.
   */
  pr?: PrReference | null;
}

export interface NeedCounts {
  all: number;
  approvals: number;
  asks: number;
  feedback: number;
  overdue: number;
}

/**
 * The message that started a piece of work — who asked and the first line of
 * what they asked. Every row falls back to it when its agent set no title.
 */
export interface TriggerAsk {
  authorPubkey: string;
  text: string;
}

export type RunRowState = "live" | "stalled" | "lost" | "reacting";

/**
 * Where a running row's lifecycle came from: the owner's observer frames, a
 * member-readable 30624 status head (Phase 8), or an agent's 💬 reaction.
 */
export type RunSource = "observer" | "status" | "reaction" | "job";

/** Label metadata shared by Running, Done and the conversation strip. */
export interface JobLabel {
  id: string;
  role: string;
  engine: string | null;
}

export interface RunRow {
  job?: JobLabel | null;
  /** `turn:<agent>:<turnId>` for both lifecycle sources, so they converge. */
  key: string;
  agentPubkey: string;
  turnId: string | null;
  channelId: string | null;
  startedAt: number | null;
  lastBeatAt: number | null;
  state: RunRowState;
  source: RunSource;
  /** From `buzz status set`, bound to this turn; null when none was set. */
  title: string | null;
  progress: TaskProgress | null;
  /** The event that started the turn (30624 `e`/trigger, observer, or 💬 target). */
  triggerId?: string | null;
  /** That event, once fetched. */
  ask?: TriggerAsk | null;
  /** The agent's latest own in-window message, cleaned for the what line. */
  latest?: string | null;
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
  /** The reacted-to event, once fetched. */
  ask?: TriggerAsk | null;
}

export interface DoneLast {
  job?: JobLabel | null;
  agentPubkey: string;
  channelId: string | null;
  at: number;
  /** From 30624 when known; metric-only rows have no start/end timestamps. */
  startedAt?: number | null;
  endedAt?: number | null;
  /**
   * How the turn ended when that was not the ordinary ending: a 44200 stop
   * reason, or a 30624 `error` / `cancelled` (with its reason). Null or
   * "end_turn" = it simply finished.
   */
  stopReason: string | null;
  /** The turn's 30624 title, when its agent set one. */
  title: string | null;
  /** The turn's triggering event (30624 only; a metric never carries one). */
  triggerId?: string | null;
  /** That event, once fetched. */
  ask?: TriggerAsk | null;
  /** The agent's last own message inside this finished turn's window. */
  latest?: string | null;
}

/** One finished turn (Phase 2: Done today lists every turn, not just the last). */
export interface DoneRow extends DoneLast {
  /** The turn id, else the metric's event id. */
  key: string;
}

export interface DoneSummary {
  state: "ready";
  /** Distinct turns finished since local midnight. */
  count: number;
  /** Events that did not decrypt — never counted as done. */
  locked: number;
  last: DoneLast | null;
  /** One per turn, newest first. `count === rows.length`. */
  rows: DoneRow[];
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

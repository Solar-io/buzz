/**
 * NIP-34 issue read model (kind:1621 plus its kind:1630-1633 statuses and
 * kind:1 comments).
 *
 * Two layers, deliberately separated:
 *
 * - `lifecycle` is protocol truth. NIP-34 defines exactly four status kinds
 *   and an issue with no status event has no lifecycle at all.
 * - `status` is the board label the Buzz desktop client derives, kept
 *   byte-for-byte compatible with `desktop/src/features/projects/projectIssues.mjs`
 *   so the same events read the same way in both clients. Everything below
 *   the four status kinds there is a label heuristic, not protocol, and is
 *   marked as such.
 *
 * Who may move an issue is protocol-shaped and enforced on read: NIP-34 scopes
 * status changes to the root author or a repository maintainer, so a status
 * event signed by anyone else is ignored rather than rendered. A client that
 * trusted the newest status would let any community member close your issues.
 */

import {
  KIND_GIT_ISSUE,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_OPEN,
  KIND_TEXT_NOTE,
} from "./kinds.ts";
import type { ProjectSourceEvent } from "./projectModels.ts";

/** The four NIP-34 lifecycle states, by the kind that asserts them. */
export type IssueLifecycle = "open" | "resolved" | "closed" | "draft";

/** Desktop-compatible board labels derived from lifecycle plus `t` labels. */
export const PROJECT_ISSUE_STATUS = {
  TRIAGE: "Triage",
  BACKLOG: "Backlog",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  DONE: "Done",
  CLOSED: "Closed",
} as const;

export type ProjectIssueStatus =
  (typeof PROJECT_ISSUE_STATUS)[keyof typeof PROJECT_ISSUE_STATUS];

export const LIFECYCLE_BY_STATUS_KIND: Record<number, IssueLifecycle> = {
  [KIND_GIT_STATUS_OPEN]: "open",
  [KIND_GIT_STATUS_MERGED]: "resolved",
  [KIND_GIT_STATUS_CLOSED]: "closed",
  [KIND_GIT_STATUS_DRAFT]: "draft",
};

export const STATUS_KIND_BY_LIFECYCLE: Record<IssueLifecycle, number> = {
  open: KIND_GIT_STATUS_OPEN,
  resolved: KIND_GIT_STATUS_MERGED,
  closed: KIND_GIT_STATUS_CLOSED,
  draft: KIND_GIT_STATUS_DRAFT,
};

/** Issue categories, carried as `t` labels (desktop's `projectTaskCategories`). */
export const PROJECT_TASK_CATEGORIES = [
  { label: "Issue", value: "issue" },
  { label: "Change request", value: "change-request" },
  { label: "Improvement", value: "improvement" },
] as const;

export type ProjectTaskCategory =
  (typeof PROJECT_TASK_CATEGORIES)[number]["value"];

const CATEGORY_VALUES = new Set<string>(
  PROJECT_TASK_CATEGORIES.map((option) => option.value),
);

export function isProjectTaskCategory(
  value: string,
): value is ProjectTaskCategory {
  return CATEGORY_VALUES.has(value.toLowerCase());
}

export function projectTaskCategoryFromLabels(
  labels: string[],
): ProjectTaskCategory {
  return (
    labels.map((label) => label.toLowerCase()).find(isProjectTaskCategory) ??
    "issue"
  );
}

/** Labels a human chose, with the category marker filtered out. */
export function projectTaskUserLabels(labels: string[]): string[] {
  return labels.filter((label) => !isProjectTaskCategory(label));
}

export type ProjectIssueComment = {
  id: string;
  content: string;
  author: string;
  createdAt: number;
};

export type ProjectIssue = {
  id: string;
  title: string;
  content: string;
  author: string;
  createdAt: number;
  /** `30617:<owner>:<dtag>` from the issue's `a` tag. */
  repoAddress: string | null;
  labels: string[];
  category: ProjectTaskCategory;
  /** `p` tags on the root — notification routing, not assignment state. */
  recipients: string[];
  /** null when no trusted status event exists yet. */
  lifecycle: IssueLifecycle | null;
  status: ProjectIssueStatus;
  statusEventId: string | null;
  /** Latest of the root, its trusted status, and its comments. */
  updatedAt: number;
  comments: ProjectIssueComment[];
};

function getTag(event: ProjectSourceEvent, name: string): string | undefined {
  const value = event.tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getAllTags(event: ProjectSourceEvent, name: string): string[] {
  return event.tags
    .filter(
      (tag) =>
        tag[0] === name && typeof tag[1] === "string" && tag[1].length > 0,
    )
    .map((tag) => tag[1]);
}

/** Owner hex out of a `30617:<owner>:<dtag>` coordinate, or null. */
function repoOwnerFromAddress(repoAddress: string | undefined): string | null {
  const owner = (repoAddress ?? "").split(":")[1] ?? "";
  return /^[a-fA-F0-9]{64}$/.test(owner) ? owner.toLowerCase() : null;
}

/**
 * Pubkeys whose status events move this issue: its author, and the owner of
 * the repository it targets. NIP-34 scopes status to the root author or a
 * maintainer; the repo coordinate is the only maintainer evidence carried on
 * the issue itself, so an untrusted signer's status is dropped on read.
 */
export function allowedActorsForRoot(
  rootEvent: ProjectSourceEvent,
): Set<string> {
  const allowed = new Set([rootEvent.pubkey.toLowerCase()]);
  const owner = repoOwnerFromAddress(getTag(rootEvent, "a"));
  if (owner) allowed.add(owner);
  return allowed;
}

/** Newest trusted status event targeting this issue as its root. */
function latestStatusForIssue(
  issue: ProjectSourceEvent,
  statusEvents: ProjectSourceEvent[],
): ProjectSourceEvent | undefined {
  const allowed = allowedActorsForRoot(issue);
  return statusEvents
    .filter(
      (event) =>
        LIFECYCLE_BY_STATUS_KIND[event.kind] !== undefined &&
        allowed.has(event.pubkey.toLowerCase()) &&
        event.tags.some((tag) => tag[0] === "e" && tag[1] === issue.id),
    )
    .sort(
      (left, right) =>
        right.created_at - left.created_at || left.id.localeCompare(right.id),
    )[0];
}

/**
 * Board label. The four status kinds are protocol; everything below them is a
 * client-side reading of `t` labels, matching the desktop exactly (NIP-34
 * calls 1633 "Draft"; both clients surface it as Triage for issues).
 */
export function statusFromLifecycle(
  lifecycle: IssueLifecycle | null,
  labels: string[],
): ProjectIssueStatus {
  if (lifecycle === "resolved") return PROJECT_ISSUE_STATUS.DONE;
  if (lifecycle === "closed") return PROJECT_ISSUE_STATUS.CLOSED;
  if (lifecycle === "draft") return PROJECT_ISSUE_STATUS.TRIAGE;

  const lowered = labels.map((label) => label.toLowerCase());
  if (lowered.includes("in-review") || lowered.includes("review")) {
    return PROJECT_ISSUE_STATUS.IN_REVIEW;
  }
  if (lowered.includes("in-progress") || lowered.includes("active")) {
    return PROJECT_ISSUE_STATUS.IN_PROGRESS;
  }
  if (lowered.includes("triage")) return PROJECT_ISSUE_STATUS.TRIAGE;
  return PROJECT_ISSUE_STATUS.BACKLOG;
}

/**
 * Which lifecycle moves this client offers from the current one. Every state
 * is reachable from every other — NIP-34 has no ordering constraint and a
 * reopen is just a later kind:1630 — so the only thing removed is the
 * no-op transition to the state the issue is already in.
 */
export function availableLifecycleTransitions(
  current: IssueLifecycle | null,
): IssueLifecycle[] {
  const all: IssueLifecycle[] = ["open", "draft", "resolved", "closed"];
  return all.filter((lifecycle) => lifecycle !== current);
}

/** True when publishing this status would actually change the issue. */
export function isLifecycleTransitionValid(
  current: IssueLifecycle | null,
  next: IssueLifecycle,
): boolean {
  return current !== next;
}

/**
 * Comments are kind:1 text notes tagged with the issue id, because the relay
 * does not register NIP-22 kind:1111 (see the same note in
 * `desktop/src/features/projects/hooks.ts`). Both `e` and the NIP-22-style
 * uppercase `E` root marker are accepted on read.
 */
function commentsForIssue(events: ProjectSourceEvent[]): ProjectIssueComment[] {
  return [...events]
    .sort(
      (left, right) =>
        left.created_at - right.created_at || left.id.localeCompare(right.id),
    )
    .map((event) => ({
      id: event.id,
      content: event.content,
      author: event.pubkey,
      createdAt: event.created_at,
    }));
}

export function eventToProjectIssue(
  issue: ProjectSourceEvent,
  statusEvents: ProjectSourceEvent[] = [],
  commentEvents: ProjectSourceEvent[] = [],
): ProjectIssue {
  const latestStatus = latestStatusForIssue(issue, statusEvents);
  const lifecycle = latestStatus
    ? (LIFECYCLE_BY_STATUS_KIND[latestStatus.kind] ?? null)
    : null;
  const comments = commentsForIssue(
    commentEvents.filter(
      (event) =>
        event.kind === KIND_TEXT_NOTE &&
        event.tags.some(
          (tag) => (tag[0] === "e" || tag[0] === "E") && tag[1] === issue.id,
        ),
    ),
  );
  const labels = getAllTags(issue, "t");
  return {
    id: issue.id,
    title:
      getTag(issue, "subject") ||
      issue.content.split("\n")[0] ||
      "Untitled issue",
    content: issue.content,
    author: issue.pubkey,
    createdAt: issue.created_at,
    repoAddress: getTag(issue, "a") ?? null,
    labels,
    category: projectTaskCategoryFromLabels(labels),
    recipients: getAllTags(issue, "p"),
    lifecycle,
    status: statusFromLifecycle(lifecycle, labels),
    statusEventId: latestStatus?.id ?? null,
    updatedAt: Math.max(
      issue.created_at,
      latestStatus?.created_at ?? 0,
      ...comments.map((comment) => comment.createdAt),
    ),
    comments,
  };
}

/** Newest activity first; a stable id tiebreak keeps the order deterministic. */
export function projectIssueEventsToIssues(
  issueEvents: ProjectSourceEvent[],
  statusEvents: ProjectSourceEvent[] = [],
  commentEvents: ProjectSourceEvent[] = [],
): ProjectIssue[] {
  return issueEvents
    .filter((event) => event.kind === KIND_GIT_ISSUE)
    .map((issue) => eventToProjectIssue(issue, statusEvents, commentEvents))
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
}

/**
 * Nostr timestamps are whole seconds, so two comments posted in the same
 * second by the same author would sort arbitrarily. Push the new one past
 * the author's latest so consecutive replies stay in the order they were
 * written.
 */
export function nextProjectIssueCommentCreatedAt(
  issue: ProjectIssue,
  now: number,
  author: string,
): number {
  const normalized = author.toLowerCase();
  return Math.max(
    now,
    ...issue.comments
      .filter((comment) => comment.author.toLowerCase() === normalized)
      .map((comment) => comment.createdAt + 1),
  );
}

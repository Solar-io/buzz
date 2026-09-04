/**
 * Triage math for the moderation queue: ordering, grouping, and labels.
 *
 * Pure and hook-free so it can be unit-tested without a relay. Adapted from
 * the desktop client's `features/settings/lib/moderationQueue.ts` — the same
 * severity ranking and target grouping, so the two clients present one
 * community's queue in the same order rather than each inventing a priority.
 *
 * Privacy invariant carried over verbatim from that module: `reporterPubkey`
 * is visible in this admin queue and MUST NEVER reach a surface the reported
 * author can see. Nothing here is rendered author-side.
 *
 * Its only import is `queueRows.ts`, which is itself import-free and names its
 * relative path with an extension — both are needed for `node --test` to load
 * this module at all.
 */

import type {
  ModerationAuditAction,
  ModerationReport,
  ReportTargetKind,
} from "./queueRows.ts";

/** NIP-56 report categories the relay accepts (`report.rs::REPORT_TYPES`). */
export type ReportType =
  | "illegal"
  | "nudity"
  | "malware"
  | "spam"
  | "impersonation"
  | "profanity"
  | "other";

/**
 * Severity rank per category — higher acts first. `illegal` tops the queue
 * because it routes to the platform-safety escalation lane rather than to
 * community discretion; the rest descend by typical community harm, and
 * `other` sinks as the catch-all. Same ranking as the desktop client's.
 */
const SEVERITY_RANK: Record<ReportType, number> = {
  illegal: 6,
  malware: 5,
  impersonation: 4,
  nudity: 3,
  spam: 2,
  profanity: 1,
  other: 0,
};

/**
 * Rank for a report type. The wire carries `report_type` as a plain string —
 * the relay validates it at ingest, but a future relay could add a category
 * this build does not know — so anything unrecognized ranks as `other` rather
 * than sorting to the top of the queue on a `NaN`.
 */
export function reportSeverity(reportType: string): number {
  return SEVERITY_RANK[reportType as ReportType] ?? SEVERITY_RANK.other;
}

/** Human label for a category; unknown values are echoed as-is. */
export function reportTypeLabel(reportType: string): string {
  switch (reportType) {
    case "illegal":
      return "Illegal content";
    case "nudity":
      return "Nudity";
    case "malware":
      return "Malware";
    case "spam":
      return "Spam";
    case "impersonation":
      return "Impersonation";
    case "profanity":
      return "Profanity";
    case "other":
      return "Other";
    default:
      return reportType;
  }
}

/**
 * Coarse tier for badge styling, kept separate from the numeric rank so the
 * visual grouping can be tuned without perturbing sort order.
 */
export type SeverityTier = "critical" | "high" | "normal";

export function severityTier(reportType: string): SeverityTier {
  if (reportType === "illegal") {
    return "critical";
  }
  if (reportType === "malware" || reportType === "impersonation") {
    return "high";
  }
  return "normal";
}

/**
 * Stable identity for the *thing* a report targets, so several reports about
 * one message collapse into one row of work. Kind-qualified so an event id and
 * an identical-looking pubkey hex cannot collide.
 */
export function targetKey(report: ModerationReport): string {
  return `${report.targetKind}:${report.target}`;
}

export interface ModerationQueueGroup {
  targetKey: string;
  targetKind: ReportTargetKind;
  target: string;
  /**
   * The channel the target lives in, if any. An event target lives in exactly
   * one channel; pubkey and blob targets are not channel-scoped and carry
   * null. This is what decides whether the channel-scoped enforcements (9005
   * delete, 9001 kick) are even addressable — and, once resolved, which
   * channel's role snapshot decides whether the viewer may send them.
   */
  channelId: string | null;
  /** Reports about this target, newest first. */
  reports: ModerationReport[];
  /** Highest severity in the group — drives group ordering. */
  maxSeverity: number;
  /** Most recent report timestamp (ISO), for tie-breaks. */
  latestCreatedAt: string;
  /** Prior accepted actions against this target, newest first. */
  priorActions: ModerationAuditAction[];
}

/** Newest-first ISO comparator. */
function byCreatedAtDesc(
  a: { createdAt: string },
  b: { createdAt: string },
): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * Does an audit row concern the same target as a group? Reports point at
 * events, pubkeys or blobs; audit rows carry only `targetPubkey` /
 * `targetEventId`, so blob groups surface no prior-action correlation. That is
 * the wire's shape, not an omission here.
 */
function actionMatchesTarget(
  action: ModerationAuditAction,
  targetKind: ReportTargetKind,
  target: string,
): boolean {
  if (targetKind === "event") {
    return action.targetEventId === target;
  }
  if (targetKind === "pubkey") {
    return action.targetPubkey === target;
  }
  return false;
}

/**
 * Build the triaged queue: reports grouped by target, each group carrying its
 * max severity, its prior actions and its reports newest-first; groups sorted
 * by severity desc, then by most-recent report desc.
 *
 * `actions` is the audit log used for the prior-actions context — pass `[]`
 * when it is unavailable (the audit read is a separate request and can fail on
 * its own; a group with no prior-action banner is the correct degradation, a
 * missing queue is not).
 */
export function buildModerationQueue(
  reports: readonly ModerationReport[],
  actions: readonly ModerationAuditAction[] = [],
): ModerationQueueGroup[] {
  const groups = new Map<string, ModerationQueueGroup>();

  for (const report of reports) {
    const key = targetKey(report);
    const existing = groups.get(key);
    if (existing) {
      existing.reports.push(report);
      existing.maxSeverity = Math.max(
        existing.maxSeverity,
        reportSeverity(report.reportType),
      );
      // A group's channel is whichever report first supplied one. Reports
      // about one event agree on its channel, but a pubkey-target report
      // carries null, so "first non-null wins" is what keeps a mixed group
      // addressable rather than losing the channel to ordering luck.
      existing.channelId = existing.channelId ?? report.channelId;
      continue;
    }
    groups.set(key, {
      targetKey: key,
      targetKind: report.targetKind,
      target: report.target,
      channelId: report.channelId,
      reports: [report],
      maxSeverity: reportSeverity(report.reportType),
      latestCreatedAt: report.createdAt,
      priorActions: [],
    });
  }

  for (const group of groups.values()) {
    group.reports.sort(byCreatedAtDesc);
    group.latestCreatedAt =
      group.reports[0]?.createdAt ?? group.latestCreatedAt;
    group.priorActions = actions
      .filter((action) =>
        actionMatchesTarget(action, group.targetKind, group.target),
      )
      .sort(byCreatedAtDesc);
  }

  return [...groups.values()].sort((a, b) => {
    if (b.maxSeverity !== a.maxSeverity) {
      return b.maxSeverity - a.maxSeverity;
    }
    return b.latestCreatedAt.localeCompare(a.latestCreatedAt);
  });
}

/** The most severe report type in a group — the badge it wears. */
export function groupTopReportType(group: ModerationQueueGroup): string {
  let top = group.reports[0]?.reportType ?? "other";
  for (const report of group.reports) {
    if (reportSeverity(report.reportType) > reportSeverity(top)) {
      top = report.reportType;
    }
  }
  return top;
}

/** Reports in a group still awaiting a decision — the ones a 9044 can close. */
export function openReports(group: ModerationQueueGroup): ModerationReport[] {
  return group.reports.filter((report) => report.status === "open");
}

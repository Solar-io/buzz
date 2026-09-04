/**
 * Shared presentation pieces for the projects surface: the pill that states an
 * issue's lifecycle, and the notice that says a listing may be short.
 */

import { AlertTriangle } from "lucide-react";

import { Badge, type BadgeProps } from "@/shared/ui/badge";
import type { IssueLifecycle } from "../lib/projectIssues.ts";

export const LIFECYCLE_LABEL: Record<IssueLifecycle, string> = {
  open: "Open",
  draft: "Draft",
  resolved: "Resolved",
  closed: "Closed",
};

const LIFECYCLE_VARIANT: Record<IssueLifecycle, BadgeProps["variant"]> = {
  open: "info",
  draft: "outline",
  resolved: "success",
  closed: "secondary",
};

/**
 * An issue with no status event shows as Open. NIP-34 defines no implicit
 * state, but "nobody has moved this yet" is what open means to a reader, and a
 * blank pill would just look like a rendering bug.
 */
export function IssueLifecycleBadge({
  lifecycle,
}: {
  lifecycle: IssueLifecycle | null;
}) {
  const effective = lifecycle ?? "open";
  return (
    <Badge variant={LIFECYCLE_VARIANT[effective]} data-testid="issue-lifecycle">
      {LIFECYCLE_LABEL[effective]}
    </Badge>
  );
}

/**
 * NIP-MP is explicit that a truncated collection must never be presented as
 * whole: a repository missing from the list is indistinguishable from one that
 * was never announced. So when enumeration could not be drained, say so on
 * screen rather than quietly showing fewer cards.
 */
export function IncompleteCollectionNotice({
  what,
}: {
  what: "projects" | "issues";
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-foreground"
      data-testid="projects-incomplete-notice"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <span>
        This relay could not be read to exhaustion, so some {what} may be
        missing from this list.
      </span>
    </div>
  );
}

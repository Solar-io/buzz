import {
  AlertTriangle,
  Ban,
  ChevronDown,
  Flag,
  ShieldAlert,
  Trash2,
  UserMinus,
} from "lucide-react";
import type { ReactNode } from "react";

import type { Profile } from "@/features/channels/hooks";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  groupTopReportType,
  reportTypeLabel,
  severityTier,
  type ModerationQueueGroup as QueueGroup,
  type SeverityTier,
} from "../lib/queue.ts";
import {
  blockReasonLabel,
  RESOLUTION_ACTIONS,
  type QueueAuthority,
  type ResolutionAction,
} from "../lib/queueAuthority.ts";
import { TimeoutDurationSubmenu } from "./TimeoutDurationSubmenu.tsx";

/**
 * One row of moderation work: every open report about a single target, what
 * was reported, who reported it, what has already been done to that target,
 * and the resolutions the viewer's actual authority permits.
 *
 * The resolve menu shows the refused resolutions too, disabled and with the
 * reason. Hiding them would leave a community admin wondering why the queue
 * offers Ban but not Kick on the same row; the answer ("you are not an
 * owner/admin of that channel") is a fact about the relay's policy and worth
 * stating once, in the place it applies.
 */

const SEVERITY_BADGE: Record<SeverityTier, string> = {
  critical: "bg-destructive/15 text-destructive",
  high: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  normal: "bg-muted text-muted-foreground",
};

const RESOLUTION_COPY: Record<
  ResolutionAction,
  { label: string; description: string; icon: ReactNode; destructive: boolean }
> = {
  delete: {
    label: "Remove message",
    description: "Tombstone the reported message and resolve.",
    icon: <Trash2 aria-hidden="true" className="h-4 w-4" />,
    destructive: true,
  },
  kick: {
    label: "Kick from channel",
    description: "Remove the author from this channel and resolve.",
    icon: <UserMinus aria-hidden="true" className="h-4 w-4" />,
    destructive: true,
  },
  ban: {
    label: "Ban from community",
    description: "Block the author community-wide and resolve.",
    icon: <Ban aria-hidden="true" className="h-4 w-4" />,
    destructive: true,
  },
  timeout: {
    label: "Time out author",
    description: "Mute the author for a while and resolve.",
    icon: null,
    destructive: false,
  },
  escalate: {
    label: "Escalate",
    description: "Route to the platform-safety lane.",
    icon: <ShieldAlert aria-hidden="true" className="h-4 w-4" />,
    destructive: false,
  },
  dismiss: {
    label: "Dismiss",
    description: "No violation — close without action.",
    icon: <Flag aria-hidden="true" className="h-4 w-4" />,
    destructive: false,
  },
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function targetLabel(group: QueueGroup): string {
  const short = truncatePubkey(group.target);
  switch (group.targetKind) {
    case "event":
      return `Message ${short}`;
    case "pubkey":
      return `Member ${short}`;
    case "blob":
      return `Attachment ${short}`;
  }
}

/** The reported content, when the event itself could be read back. */
function ReportedContent({
  authorLabel,
  content,
}: {
  authorLabel: string | null;
  content: string | null;
}) {
  if (content === null) {
    return (
      <p className="rounded-md border border-dashed border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
        The reported message could not be loaded — it may already have been
        removed.
      </p>
    );
  }
  const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content;
  return (
    <div className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5">
      {authorLabel ? (
        <p className="text-2xs font-medium text-muted-foreground">
          {authorLabel}
        </p>
      ) : null}
      <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/90">
        {preview || "(no text content)"}
      </p>
    </div>
  );
}

function ResolveMenu({
  authority,
  busy,
  onResolve,
  testIdPrefix,
}: {
  authority: QueueAuthority;
  busy: boolean;
  onResolve: (action: ResolutionAction, timeoutExpiresAt?: number) => void;
  testIdPrefix: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          data-testid={`${testIdPrefix}-trigger`}
          disabled={busy}
          size="sm"
          type="button"
        >
          Resolve
          <ChevronDown aria-hidden="true" className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Resolution</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {RESOLUTION_ACTIONS.map((action) => {
          const copy = RESOLUTION_COPY[action];
          const blockedBy = authority.blocked[action];
          if (action === "timeout" && !blockedBy) {
            return (
              <TimeoutDurationSubmenu
                key={action}
                label={copy.label}
                onSelect={(expiresAt) => onResolve("timeout", expiresAt)}
                testIdPrefix={`${testIdPrefix}-timeout`}
              />
            );
          }
          return (
            <DropdownMenuItem
              className={
                copy.destructive && !blockedBy
                  ? "text-destructive focus:text-destructive"
                  : undefined
              }
              data-testid={`${testIdPrefix}-${action}`}
              disabled={Boolean(blockedBy)}
              key={action}
              onSelect={() => {
                if (!blockedBy) {
                  onResolve(action);
                }
              }}
            >
              {copy.icon}
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{copy.label}</span>
                <span className="text-xs text-muted-foreground/80">
                  {blockedBy ? blockReasonLabel(blockedBy) : copy.description}
                </span>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ModerationQueueGroupCard({
  group,
  authority,
  profiles,
  channelName,
  reportedAuthorPubkey,
  reportedContent,
  busy,
  onResolve,
}: {
  group: QueueGroup;
  authority: QueueAuthority;
  /** Profiles for reporter and author names, keyed by pubkey. */
  profiles: Map<string, Profile>;
  /** Name of the reported message's channel, when the shell knows it. */
  channelName: string | null;
  reportedAuthorPubkey: string | null;
  reportedContent: string | null;
  busy: boolean;
  onResolve: (action: ResolutionAction, timeoutExpiresAt?: number) => void;
}) {
  const topType = groupTopReportType(group);
  const tier = severityTier(topType);
  const nameOf = (pubkey: string): string =>
    profiles.get(pubkey)?.displayName?.trim() || truncatePubkey(pubkey);

  return (
    <div
      className="space-y-2.5 rounded-lg border border-border/60 bg-card/60 p-3"
      data-testid={`moderation-group-${group.targetKey}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
              SEVERITY_BADGE[tier],
            )}
          >
            {tier === "critical" ? (
              <ShieldAlert aria-hidden="true" className="mr-1 h-3 w-3" />
            ) : null}
            {reportTypeLabel(topType)}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {targetLabel(group)}
          </span>
          {channelName ? (
            <span className="text-xs text-muted-foreground">
              in #{channelName}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            · {group.reports.length}{" "}
            {group.reports.length === 1 ? "report" : "reports"}
          </span>
        </div>
        <div className="shrink-0">
          {/* Its own prefix, not the card's: a `^=` selector for the cards
              would otherwise also match every control inside them. */}
          <ResolveMenu
            authority={authority}
            busy={busy}
            onResolve={onResolve}
            testIdPrefix={`moderation-resolve-${group.targetKey}`}
          />
        </div>
      </div>

      {group.targetKind === "event" ? (
        <ReportedContent
          authorLabel={
            reportedAuthorPubkey ? nameOf(reportedAuthorPubkey) : null
          }
          content={reportedContent}
        />
      ) : null}

      <div className="space-y-1.5">
        {group.reports.map((report) => (
          <div
            className="rounded-md border border-border/50 bg-background/50 px-2.5 py-1.5"
            key={report.id}
          >
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">
                {reportTypeLabel(report.reportType)}
              </span>
              <span className="text-muted-foreground">
                reported by {nameOf(report.reporterPubkey)} ·{" "}
                {formatTimestamp(report.createdAt)}
              </span>
            </div>
            {report.note ? (
              <p className="mt-1 text-xs text-muted-foreground/80">
                {report.note}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {group.priorActions.length > 0 ? (
        <div className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
          <span>
            {group.priorActions.length} prior action
            {group.priorActions.length === 1 ? "" : "s"} against this target
            {" — "}
            {group.priorActions
              .slice(0, 3)
              .map((action) => action.action)
              .join(", ")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

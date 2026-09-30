import { Bell, GitBranch } from "lucide-react";

import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useReminderSummary } from "@/features/reminders/hooks";
import { displayText } from "@/features/reminders/lib/reminderSummary.ts";
import type { Reminder } from "@/features/reminders/lib/reminderTypes.ts";
import { cn } from "@/shared/lib/cn";
import { HexAvatar, HumanAvatar } from "@/shared/ui/HexAvatar";
import type { NeedRow as Row } from "../lib/workTypes.ts";
import { type ActionSize, NeedActions } from "./NeedActions";
import {
  channelLabel,
  dueLabel,
  metaLine,
  overdueLabel,
  shortAge,
} from "./workLabels.ts";

/** Everything a row reads besides the row itself. */
export interface NeedRowContext {
  nowS: number;
  channels: readonly ChannelSummary[];
  profiles: Map<string, Profile>;
  agentPubkeys: ReadonlySet<string>;
  runningAgents: ReadonlySet<string>;
  selfPubkey: string | null;
  onOpen: (row: Row) => void;
  onOpenView: (view: "workflows" | "reminders") => void;
  onMarkRead: (row: Row) => void;
}

const KIND_LABEL: Record<Row["kind"], string> = {
  approval: "APPROVAL",
  ask: "ASK",
  mention: "MENTION",
  feedback: "FEEDBACK",
};

const KIND_TONE: Record<Row["kind"], string> = {
  approval: "text-coral-ink",
  ask: "text-info-ink",
  mention: "text-info-ink",
  feedback: "text-muted-foreground",
};

function RowMark({
  row,
  ctx,
  size,
}: {
  row: Row;
  ctx: NeedRowContext;
  size: number;
}) {
  if (row.kind === "feedback") {
    return (
      <span
        aria-hidden
        className="mt-px grid shrink-0 place-items-center rounded-full bg-coral-soft text-coral-ink"
        style={{ width: size, height: size }}
      >
        <Bell className="size-2.75" />
      </span>
    );
  }
  if (!row.actorPubkey) {
    return (
      <span
        aria-hidden
        className="grid shrink-0 place-items-center rounded-md bg-chip text-ink-2"
        style={{ width: size, height: size }}
      >
        <GitBranch className="size-3" />
      </span>
    );
  }
  const label = authorLabel(row.actorPubkey, ctx.profiles);
  if (
    !ctx.agentPubkeys.has(row.actorPubkey.toLowerCase()) &&
    !ctx.agentPubkeys.has(row.actorPubkey)
  ) {
    return <HumanAvatar label={label} size={size} />;
  }
  const running = ctx.runningAgents.has(row.actorPubkey);
  return (
    <HexAvatar
      label={label}
      seed={row.actorPubkey}
      size={size}
      ring={running ? "work" : row.kind === "mention" ? "idle" : "need"}
    />
  );
}

/** A feedback row upgrades to the AI summary when the bridge has one. */
function FeedbackTitle({
  reminder,
  fallback,
}: {
  reminder: Reminder;
  fallback: string;
}) {
  const summary = useReminderSummary(reminder);
  const note = reminder.content.note?.trim();
  const shown = !note && summary ? displayText(reminder, summary) : null;
  return (
    <>
      {shown?.isSummary ? (
        <span className="mr-1.25 rounded-[3px] bg-chip px-1 font-mono text-badge font-semibold text-muted-foreground">
          AI
        </span>
      ) : null}
      {shown?.text ?? fallback}
    </>
  );
}

function RowTitle({ row }: { row: Row }) {
  return row.source.kind === "feedback" ? (
    <FeedbackTitle reminder={row.source.reminder} fallback={row.title} />
  ) : (
    <>{row.title}</>
  );
}

function rowMeta(row: Row, ctx: NeedRowContext) {
  const where =
    row.kind === "approval"
      ? metaLine("workflow", channelLabel(row.channelId, ctx.channels))
      : row.kind === "feedback" && row.actorPubkey
        ? authorLabel(row.actorPubkey, ctx.profiles)
        : channelLabel(row.channelId, ctx.channels);
  const when =
    row.kind === "feedback" ? (
      (row.overdueBy ?? 0) > 0 ? (
        <span className="font-semibold text-coral-ink">
          {overdueLabel(row.overdueBy ?? 0)}
        </span>
      ) : (
        dueLabel(row.at, ctx.nowS)
      )
    ) : null;
  return (
    <>
      <span
        className={cn("font-semibold tracking-[0.06em]", KIND_TONE[row.kind])}
      >
        {KIND_LABEL[row.kind]}
      </span>
      {where ? <> · {where}</> : null}
      {when ? <> · {when}</> : null}
    </>
  );
}

/** One Needs-you row: compact, or expanded with its actions. */
export function NeedRowView({
  row,
  ctx,
  expanded,
  size,
  onExpand,
}: {
  row: Row;
  ctx: NeedRowContext;
  expanded: boolean;
  size: ActionSize;
  onExpand: () => void;
}) {
  const page = size === "page";
  const age = row.kind === "feedback" ? null : shortAge(row.at, ctx.nowS);
  const mark = page ? (expanded ? 26 : 24) : 20;
  return (
    <div
      data-testid={`need-row-${row.key}`}
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "border-b border-border last:border-b-0",
        expanded && !page && "bg-sunk",
        page ? "px-3.5 py-3" : expanded ? "px-3 pt-2.5 pb-2.75" : "px-3 py-2",
      )}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2.25 text-left"
      >
        <RowMark row={row} ctx={ctx} size={mark} />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block",
              page ? "text-base leading-snug" : "text-sidebar-meta",
              expanded ? "font-semibold" : "truncate",
              expanded && page ? "line-clamp-3" : expanded && "line-clamp-2",
            )}
          >
            <RowTitle row={row} />
          </span>
          <span
            className={cn(
              "mt-px block truncate font-mono text-muted-foreground",
              page ? "text-xs" : "text-2xs",
            )}
          >
            {rowMeta(row, ctx)}
          </span>
        </span>
        {age ? (
          <span className="shrink-0 pt-px font-mono text-2xs text-muted-foreground">
            {age}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className={cn(page ? "mt-3" : "mt-2.25 ml-7.25")}>
          <NeedActions
            row={row}
            size={size}
            selfPubkey={ctx.selfPubkey}
            onOpen={() => ctx.onOpen(row)}
            onOpenView={ctx.onOpenView}
            onMarkRead={() => ctx.onMarkRead(row)}
          />
        </div>
      ) : null}
    </div>
  );
}

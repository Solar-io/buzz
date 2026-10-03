import { Check, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { cn } from "@/shared/lib/cn";
import { HexAvatar, StateHex } from "@/shared/ui/HexAvatar";
import type { DoneRow, DoneState, QueuedRow } from "../lib/workTypes.ts";
import { SectionHeader } from "./NeedsYouSection";
import { channelLabel, clockLabel, metaLine, shortAge } from "./workLabels.ts";
import { JobSuffix } from "./JobSuffix";
import { whatLine } from "./whatLine.ts";

/**
 * A Queued / Done row's text: "Name  #channel" on top and, when known, what
 * the work is underneath — the agent's title, else the message that asked.
 */
function WhoWhat({
  name,
  job,
  meta,
  what,
  trailing = null,
}: {
  name: string;
  job?: DoneRow["job"];
  meta: string;
  what: string | null;
  trailing?: ReactNode;
}) {
  const top = (
    <>
      <b className="font-semibold">{name}</b>
      <JobSuffix job={job} />
      <span className="text-muted-foreground">
        {meta ? `${job ? " · " : " "}${meta}` : null}
        {trailing}
      </span>
    </>
  );
  if (!what) {
    return (
      <span className="min-w-0 flex-1 truncate text-sidebar-meta">{top}</span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sidebar-meta">{top}</span>
      <span
        data-testid="work-row-ask"
        title={what}
        className="truncate text-xs text-ink-2"
      >
        {what}
      </span>
    </span>
  );
}

/** The folded card Queued and Done collapse to (Main: 34px summary rows). */
function FoldedSummary({
  marker,
  label,
  count,
  summary,
  onExpand,
}: {
  marker: ReactNode;
  label: string;
  count: number;
  summary: string;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={onExpand}
      className="flex h-8.5 w-full items-center gap-1.75 rounded-[10px] border border-border bg-card pr-3 pl-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:bg-accent"
    >
      <ChevronRight aria-hidden className="size-3 shrink-0" />
      {marker}
      <span className="shrink-0 whitespace-nowrap">{label}</span>
      <span className="font-mono tracking-normal text-foreground">{count}</span>
      <span className="ml-auto min-w-0 truncate pl-2 text-xs font-medium normal-case tracking-normal">
        {summary}
      </span>
    </button>
  );
}

/**
 * Queued (phase-1 §2.5): events an agent reacted 👀 to and has not started.
 * Oldest first — "next" is the head of the queue.
 */
export function QueuedSection({
  rows,
  nowS,
  channels,
  profiles,
  collapsed,
  onToggle,
  onOpenMessage,
}: {
  rows: QueuedRow[];
  nowS: number;
  channels: readonly ChannelSummary[];
  profiles: Map<string, Profile>;
  collapsed: boolean;
  onToggle: () => void;
  onOpenMessage: (channelId: string, messageId: string) => void;
}) {
  if (rows.length === 0) {
    return null;
  }
  const next = rows[0];
  const marker = <StateHex tone="idle" size={10} />;
  if (collapsed) {
    return (
      <FoldedSummary
        marker={marker}
        label="Queued"
        count={rows.length}
        summary={`next: ${metaLine(
          authorLabel(next.agentPubkey, profiles),
          channelLabel(next.channelId, channels),
        )}`}
        onExpand={onToggle}
      />
    );
  }
  return (
    <section aria-label="Queued" className="flex flex-col gap-1.5">
      <SectionHeader
        label="Queued"
        count={rows.length}
        tone="text-muted-foreground"
        marker={marker}
        collapsed={false}
        onToggle={onToggle}
      />
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((row, index) => {
          const name = authorLabel(row.agentPubkey, profiles);
          const what = whatLine(null, row.ask, profiles);
          return (
            <button
              key={row.key}
              type="button"
              disabled={!row.channelId}
              onClick={() =>
                row.channelId && onOpenMessage(row.channelId, row.eventId)
              }
              className={cn(
                "flex w-full items-center gap-2.25 border-b border-border px-3 text-left last:border-b-0 hover:bg-accent disabled:cursor-default",
                what ? "min-h-11 py-1" : "h-8.5",
              )}
            >
              <HexAvatar
                label={name}
                seed={row.agentPubkey}
                size={18}
                ring="idle"
              />
              <WhoWhat
                name={name}
                meta={metaLine(
                  index === 0 && "next",
                  channelLabel(row.channelId, channels),
                )}
                what={what}
              />
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                {shortAge(row.at, nowS)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Done today (phase-1 §2.6, Phase 8): 30624 terminal heads for every agent in
 * the viewer's channels, plus the 44200 turn metrics of their own agents.
 * Loading and unavailable render nothing — never a "0" the data does not
 * carry; a locked key with no status to fall back on says so.
 */
export function DoneSection({
  done,
  channels,
  profiles,
  collapsed,
  onToggle,
  onOpenChannel,
}: {
  done: DoneState;
  channels: readonly ChannelSummary[];
  profiles: Map<string, Profile>;
  collapsed: boolean;
  onToggle: () => void;
  onOpenChannel: (channelId: string) => void;
}) {
  if (done.state === "loading" || done.state === "unavailable") {
    return null;
  }
  const marker = (
    <Check
      aria-hidden
      className="size-3 shrink-0 text-leaf"
      strokeWidth={2.4}
    />
  );
  if (done.state === "locked") {
    return (
      <p className="flex h-8.5 items-center gap-1.75 rounded-[10px] border border-dashed border-border px-3 text-xs text-muted-foreground">
        {marker} Done today is locked — unlock your key to read turn metrics.
      </p>
    );
  }
  const last = done.last;
  // Main: "last: Beat 01 captured" — what was done, when the agent said so;
  // otherwise who, where and when.
  const lastLine = last
    ? (whatLine(last.title, last.ask, profiles, last.latest) ??
      metaLine(
        authorLabel(last.agentPubkey, profiles),
        channelLabel(last.channelId, channels),
        clockLabel(last.at),
      ))
    : "";
  if (collapsed) {
    return (
      <FoldedSummary
        marker={marker}
        label="Done today"
        count={done.count}
        summary={last ? `last: ${lastLine}` : ""}
        onExpand={onToggle}
      />
    );
  }
  return (
    <section aria-label="Done today" className="flex flex-col gap-1.5">
      <SectionHeader
        label="Done today"
        count={done.count}
        tone="text-leaf-ink"
        marker={marker}
        collapsed={false}
        onToggle={onToggle}
        trailing={done.locked > 0 ? `${done.locked} locked` : null}
      />
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {done.rows.length === 0 ? (
          <p className="px-3 py-2 text-sidebar-meta text-muted-foreground">
            No turns finished yet today.
          </p>
        ) : (
          <DoneRows
            rows={done.rows}
            channels={channels}
            profiles={profiles}
            onOpenChannel={onOpenChannel}
          />
        )}
      </div>
    </section>
  );
}

/** Turns listed before "Show N more". */
export const DONE_PAGE = 6;

/**
 * One row per finished turn, newest first (Phase 2): who, what (its 30624
 * title, Phase 8), where, when, and how the turn ended. `end_turn` / `done`
 * is the ordinary ending and says nothing; anything else — a cancel, a
 * refusal, an error, a harness restart — is shown, because a turn that did
 * not end normally is the one worth a second look.
 */
function DoneRows({
  rows,
  channels,
  profiles,
  onOpenChannel,
}: {
  rows: readonly DoneRow[];
  channels: readonly ChannelSummary[];
  profiles: Map<string, Profile>;
  onOpenChannel: (channelId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, DONE_PAGE);
  return (
    <>
      {shown.map((row) => {
        const name = authorLabel(row.agentPubkey, profiles);
        const abnormal =
          row.stopReason !== null && row.stopReason !== "end_turn";
        const what = whatLine(
          row.title,
          row.ask,
          profiles,
          row.job ? null : row.latest,
        );
        return (
          <button
            key={row.key}
            type="button"
            data-testid="done-row"
            data-row-key={row.key}
            disabled={!row.channelId}
            onClick={() => row.channelId && onOpenChannel(row.channelId)}
            className={cn(
              "flex w-full items-center gap-2.25 border-b border-border px-3 text-left last:border-b-0 hover:bg-accent disabled:cursor-default",
              what ? "min-h-11 py-1" : "h-8.5",
            )}
          >
            <HexAvatar
              label={name}
              seed={row.agentPubkey}
              size={18}
              ring="idle"
            />
            <WhoWhat
              name={name}
              job={row.job}
              meta={channelLabel(row.channelId, channels) || "heartbeat"}
              what={what}
              trailing={
                abnormal ? (
                  <span className="text-coral-ink"> · {row.stopReason}</span>
                ) : null
              }
            />
            <span
              className={cn(
                "shrink-0 font-mono text-2xs",
                abnormal ? "text-coral-ink" : "text-muted-foreground",
              )}
            >
              {clockLabel(row.at)}
            </span>
          </button>
        );
      })}
      {rows.length > shown.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="h-8 w-full px-3 text-left text-xs font-semibold text-info-ink hover:bg-accent"
        >
          Show {rows.length - shown.length} more
        </button>
      )}
    </>
  );
}

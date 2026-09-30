import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { cn } from "@/shared/lib/cn";
import { HexAvatar, StateHex } from "@/shared/ui/HexAvatar";
import type { DoneState, QueuedRow } from "../lib/workTypes.ts";
import { SectionHeader } from "./NeedsYouSection";
import { channelLabel, clockLabel, metaLine, shortAge } from "./workLabels.ts";

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
          return (
            <button
              key={row.key}
              type="button"
              disabled={!row.channelId}
              onClick={() =>
                row.channelId && onOpenMessage(row.channelId, row.eventId)
              }
              className="flex h-8.5 w-full items-center gap-2.25 border-b border-border px-3 text-left last:border-b-0 hover:bg-accent disabled:cursor-default"
            >
              <HexAvatar
                label={name}
                seed={row.agentPubkey}
                size={18}
                ring="idle"
              />
              <span className="min-w-0 flex-1 truncate text-sidebar-meta">
                <b className="font-semibold">{name}</b>
                <span className="text-muted-foreground">
                  {" "}
                  {metaLine(
                    index === 0 && "next",
                    channelLabel(row.channelId, channels),
                  )}
                </span>
              </span>
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
 * Done today (phase-1 §2.6), from 44200 turn metrics. Loading and
 * unavailable render nothing — never a "0" the data does not carry; a locked
 * key says so.
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
  const lastLine = last
    ? metaLine(
        authorLabel(last.agentPubkey, profiles),
        channelLabel(last.channelId, channels),
        clockLabel(last.at),
      )
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
        {last ? (
          <button
            type="button"
            disabled={!last.channelId}
            onClick={() => last.channelId && onOpenChannel(last.channelId)}
            className={cn(
              "flex h-8.5 w-full items-center gap-2.25 px-3 text-left hover:bg-accent disabled:cursor-default",
            )}
          >
            <HexAvatar
              label={authorLabel(last.agentPubkey, profiles)}
              seed={last.agentPubkey}
              size={18}
              ring="idle"
            />
            <span className="min-w-0 flex-1 truncate text-sidebar-meta text-muted-foreground">
              <span className="text-foreground">Last:</span> {lastLine}
              {last.stopReason ? ` · ${last.stopReason}` : ""}
            </span>
          </button>
        ) : (
          <p className="px-3 py-2 text-sidebar-meta text-muted-foreground">
            No turns finished yet today.
          </p>
        )}
      </div>
    </section>
  );
}

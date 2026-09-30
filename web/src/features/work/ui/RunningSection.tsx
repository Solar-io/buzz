import { X } from "lucide-react";

import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { cn } from "@/shared/lib/cn";
import { HexAvatar, StateHex } from "@/shared/ui/HexAvatar";
import type { RunRow } from "../lib/workTypes.ts";
import { SectionHeader } from "./NeedsYouSection";
import { channelLabel, clockLabel, elapsedLabel } from "./workLabels.ts";

/**
 * Running (phase-1 §2.4). Honesty over guessing: a silent turn reads "no
 * heartbeat" and stays listed; after ten minutes it reads "lost"; only the
 * viewer's Dismiss removes it. Reaction-derived rows (agents the viewer does
 * not own) say "working · since …" and never claim an elapsed heartbeat.
 */
function RunStatus({ row, nowS }: { row: RunRow; nowS: number }) {
  switch (row.state) {
    case "live":
      return (
        <>{row.startedAt !== null ? elapsedLabel(row.startedAt, nowS) : ""}</>
      );
    case "stalled":
      return (
        <span className="text-coral-ink">
          no heartbeat · {elapsedLabel(row.lastBeatAt ?? nowS, nowS)}
        </span>
      );
    case "lost":
      return (
        <span className="text-coral-ink">
          lost · last seen {clockLabel(row.lastBeatAt ?? nowS)}
        </span>
      );
    case "reacting":
      return <>working · since {clockLabel(row.startedAt ?? nowS)}</>;
  }
}

export function RunningSection({
  rows,
  nowS,
  channels,
  profiles,
  collapsed,
  onToggle,
  onOpenChannel,
  onDismiss,
  size = "rail",
  showHeader = true,
}: {
  rows: RunRow[];
  nowS: number;
  channels: readonly ChannelSummary[];
  profiles: Map<string, Profile>;
  collapsed: boolean;
  onToggle: () => void;
  onOpenChannel: (channelId: string) => void;
  onDismiss: (turnId: string) => void;
  size?: "rail" | "page";
  showHeader?: boolean;
}) {
  const stalled = rows.filter(
    (row) => row.state === "stalled" || row.state === "lost",
  ).length;
  const page = size === "page";
  return (
    <section aria-label="Running" className="flex flex-col gap-1.5">
      {showHeader && (
        <SectionHeader
          label="Running"
          count={rows.length}
          tone="text-honey-ink"
          marker={<StateHex tone="work" size={10} pulse={rows.length > 0} />}
          collapsed={collapsed}
          onToggle={onToggle}
          trailing={
            stalled > 0 ? (
              <span className="text-coral-ink">{stalled} stalled</span>
            ) : null
          }
        />
      )}
      {!collapsed &&
        (rows.length === 0 ? (
          <p className="px-0.5 text-sidebar-meta text-muted-foreground">
            No agents are working.
          </p>
        ) : (
          <div
            className={cn(
              "overflow-hidden border border-border bg-card",
              page ? "rounded-[14px]" : "rounded-xl",
            )}
          >
            {rows.map((row) => {
              const name = authorLabel(row.agentPubkey, profiles);
              const where =
                row.channelId === null && row.source === "observer"
                  ? "heartbeat"
                  : channelLabel(row.channelId, channels);
              const quiet = row.state === "stalled" || row.state === "lost";
              return (
                <div
                  key={row.key}
                  data-testid={`run-row-${row.state}`}
                  className={cn(
                    "flex items-center gap-2.25 border-b border-border px-3 last:border-b-0",
                    page ? "min-h-13" : "h-8.5",
                  )}
                >
                  <button
                    type="button"
                    disabled={!row.channelId}
                    onClick={() =>
                      row.channelId && onOpenChannel(row.channelId)
                    }
                    className="flex min-w-0 flex-1 items-center gap-2.25 text-left disabled:cursor-default"
                  >
                    <HexAvatar
                      label={name}
                      seed={row.agentPubkey}
                      size={page ? 22 : 18}
                      ring={
                        quiet
                          ? "need"
                          : row.state === "reacting"
                            ? "idle"
                            : "work"
                      }
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        page ? "text-sm" : "text-sidebar-meta",
                      )}
                    >
                      <b className="font-semibold">{name}</b>
                      {where ? (
                        <span className="text-muted-foreground"> {where}</span>
                      ) : null}
                    </span>
                  </button>
                  <span className="shrink-0 text-right font-mono text-2xs text-muted-foreground">
                    <RunStatus row={row} nowS={nowS} />
                  </span>
                  {quiet && row.turnId ? (
                    <button
                      type="button"
                      aria-label={`Dismiss ${name}'s silent turn`}
                      onClick={() => row.turnId && onDismiss(row.turnId)}
                      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X aria-hidden className="size-3" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
}

import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { cn } from "@/shared/lib/cn";
import { HexAvatar } from "@/shared/ui/HexAvatar";
import type { RunRow } from "../lib/workTypes.ts";
import { useNowSeconds, useWorkFeed } from "../useWorkFeed.ts";
import { clockLabel, elapsedLabel } from "./workLabels.ts";

/** What the strip says about the turns running in one channel. */
export interface RunningSummary {
  /** The rows being described: live and reacting first, then silent ones. */
  rows: RunRow[];
  /** "is working" / "are working" / "has gone quiet". */
  verb: string;
  /** Every row is a silent (stalled or lost) turn. */
  quiet: boolean;
}

/**
 * Pure: which running rows a channel's strip describes and in what words.
 * A working turn outranks a silent one — the strip names the agents that are
 * working, and only when none are does it say a turn has gone quiet.
 */
export function runningSummary(rows: readonly RunRow[]): RunningSummary | null {
  const working = rows.filter(
    (row) => row.state === "live" || row.state === "reacting",
  );
  if (working.length > 0) {
    return {
      rows: working,
      verb: working.length === 1 ? "is working" : "are working",
      quiet: false,
    };
  }
  const silent = rows.filter(
    (row) => row.state === "stalled" || row.state === "lost",
  );
  if (silent.length === 0) {
    return null;
  }
  return {
    rows: silent,
    verb: silent.length === 1 ? "has gone quiet" : "have gone quiet",
    quiet: true,
  };
}

/** "A", "A and B", "A, B and 2 more". */
export function runningNames(names: readonly string[]): string[] {
  if (names.length <= 2) {
    return [...names];
  }
  return [names[0], names[1], `${names.length - 2} more`];
}

/**
 * Who is working in THIS conversation, as one line (Main and PhoneChannel
 * artboards): under the composer at md and up, under the header on a phone.
 *
 * It replaces the DM-only "received it and is working" row that used to sit
 * at the bottom of the timeline — this one reads the same Work feed the rail
 * does, so it covers channels too and can never disagree with Running.
 *
 * Honest by the same rules as the rail (VISION_ACTIVITY): it says an agent
 * IS WORKING and for how long, because that is all a turn's lifecycle
 * carries. What it is working on, and how far along, arrive with task status
 * (Phase 8); until then the strip makes no claim about either. A turn with
 * no heartbeat is named as quiet, never hidden.
 */
export function RunningStrip({
  channelId,
  profiles,
  variant,
}: {
  channelId: string;
  profiles: Map<string, Profile>;
  /** "line" sits under the composer; "bar" is the phone's strip. */
  variant: "line" | "bar";
}) {
  const coarse = useNowSeconds(15_000);
  const feed = useWorkFeed({ scope: "channel", channelId, nowS: coarse });
  const summary = runningSummary(feed.running);
  // Tick every second only while an elapsed counter is on screen.
  const nowS = useNowSeconds(1_000, summary !== null);
  if (!summary) {
    return null;
  }
  const names = runningNames(
    summary.rows.map((row) => authorLabel(row.agentPubkey, profiles)),
  );
  const first = summary.rows[0];
  const timing =
    summary.rows.length !== 1
      ? null
      : first.state === "reacting"
        ? `since ${clockLabel(first.startedAt ?? nowS)}`
        : summary.quiet
          ? `no heartbeat · ${elapsedLabel(first.lastBeatAt ?? nowS, Math.max(nowS, coarse))}`
          : first.startedAt !== null
            ? elapsedLabel(first.startedAt, Math.max(nowS, coarse))
            : null;
  const ring = summary.quiet ? "need" : "work";
  return (
    <div
      role="status"
      data-testid={`running-strip-${variant}`}
      className={cn(
        "flex min-w-0 items-center gap-2",
        variant === "bar"
          ? "border-b border-border px-4 py-2 text-sidebar-meta md:hidden"
          : "hidden px-1 pt-2.25 text-xs md:flex",
        variant === "bar" && (summary.quiet ? "bg-coral-wash" : "bg-honey-wash"),
      )}
    >
      <HexAvatar
        label={authorLabel(first.agentPubkey, profiles)}
        seed={first.agentPubkey}
        size={18}
        ring={ring}
        pulse={!summary.quiet}
      />
      <span className="min-w-0 truncate text-ink-2">
        {names.map((name, index) => (
          <span key={name}>
            {index > 0 && (index === names.length - 1 ? " and " : ", ")}
            <b className="font-semibold text-foreground">{name}</b>
          </span>
        ))}{" "}
        <span className={summary.quiet ? "text-coral-ink" : undefined}>
          {summary.verb}
        </span>
      </span>
      {!summary.quiet && (
        <span aria-hidden className="flex shrink-0 gap-0.75">
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-1 rounded-full bg-work motion-safe:animate-pulse"
              style={{ animationDelay: `${dot * 200}ms` }}
            />
          ))}
        </span>
      )}
      {timing && (
        <span
          className={cn(
            "ml-auto shrink-0 font-mono text-2xs",
            summary.quiet ? "text-coral-ink" : "text-muted-foreground",
          )}
        >
          {timing}
        </span>
      )}
    </div>
  );
}

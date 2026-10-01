import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { cn } from "@/shared/lib/cn";
import { HexAvatar } from "@/shared/ui/HexAvatar";
import { progressText } from "../lib/taskStatus.ts";
import type { RunRow } from "../lib/workTypes.ts";
import { useNowSeconds, useWorkFeed } from "../useWorkFeed.ts";
import { ProgressSegments } from "./ProgressSegments";
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
 * Pure: who to name as typing beside the running rows. Typing frames
 * (kind 20002) come from people AND from agents — a harness sends them for
 * its whole turn — so anyone the channel's running rows already name is
 * dropped: an agent at work is said once, as working. A person typing, or an
 * agent typing with no lifecycle row to speak for it, is still said.
 */
export function typingOthers(
  typingPubkeys: readonly string[],
  running: readonly RunRow[],
): string[] {
  const named = new Set(running.map((row) => row.agentPubkey.toLowerCase()));
  return typingPubkeys.filter((pubkey) => !named.has(pubkey.toLowerCase()));
}

/** Three dots, staggered — the "something is coming" glyph. */
function Dots({ tone }: { tone: "work" | "muted" }) {
  return (
    <span aria-hidden className="flex shrink-0 gap-0.75">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className={cn(
            "size-1 rounded-full motion-safe:animate-pulse",
            tone === "work" ? "bg-work" : "bg-muted-foreground",
          )}
          style={{ animationDelay: `${dot * 200}ms` }}
        />
      ))}
    </span>
  );
}

/** Bold names joined "A", "A and B", "A, B and 2 more". */
function NameList({ names }: { names: readonly string[] }) {
  return names.map((name, index) => (
    <span key={name}>
      {index > 0 && (index === names.length - 1 ? " and " : ", ")}
      <b className="font-semibold text-foreground">{name}</b>
    </span>
  ));
}

/**
 * Who is about to answer in THIS conversation (Main and PhoneChannel
 * artboards): directly above the composer's box at md and up, under the
 * header on a phone.
 *
 * It is the ONE "someone is on it" signal around the composer (Sam,
 * 2026-09-30): the timeline's "is typing" row and the box's "will be
 * notified" line are gone. It reads the same Work feed the rail does, so it
 * covers channels too and can never disagree with Running. People typing
 * (`typing`, line only) ride in the same slot — visible at every width,
 * since a phone has no other place that says so.
 *
 * Honest by the same rules as the rail (VISION_ACTIVITY): it says an agent
 * IS WORKING and for how long. What it is working on, and how far along,
 * show only when the agent said so for THIS turn (`buzz status set`, 30624
 * detail bound by turn id — Phase 8); otherwise the strip makes no claim
 * about either. A turn with no heartbeat is named as quiet, never hidden.
 */
export function RunningStrip({
  channelId,
  profiles,
  variant,
  typing = [],
}: {
  channelId: string;
  profiles: Map<string, Profile>;
  /** "line" sits above the composer's box; "bar" is the phone's strip. */
  variant: "line" | "bar";
  /** Pubkeys typing here right now, the viewer excluded ("line" only). */
  typing?: readonly string[];
}) {
  const coarse = useNowSeconds(15_000);
  const feed = useWorkFeed({ scope: "channel", channelId, nowS: coarse });
  const summary = runningSummary(feed.running);
  // Tick every second only while an elapsed counter is on screen.
  const nowS = useNowSeconds(1_000, summary !== null);
  // Only the line carries typing; the phone's bar is about agents at work.
  const typists = variant === "line" ? typingOthers(typing, feed.running) : [];
  const typingLine =
    typists.length > 0 ? (
      <div
        role="status"
        data-testid="typing-line"
        className="flex min-w-0 items-center gap-2 px-1 pb-1.5 text-xs"
      >
        <span className="flex w-4.5 shrink-0 justify-center">
          <Dots tone="muted" />
        </span>
        <span className="min-w-0 truncate text-ink-2">
          <NameList
            names={runningNames(
              typists.map((pubkey) => authorLabel(pubkey, profiles)),
            )}
          />{" "}
          {typists.length === 1 ? "is typing" : "are typing"}
        </span>
      </div>
    ) : null;
  if (!summary) {
    return typingLine;
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
  // One working turn that said what it is doing: name it (Phase 8).
  const single = summary.rows.length === 1 && !summary.quiet ? first : null;
  const title = single?.title != null ? single.title : null;
  const progress = single?.progress != null ? single.progress : null;
  const strip = (
    <div
      role="status"
      data-testid={`running-strip-${variant}`}
      className={cn(
        "flex min-w-0 items-center gap-2",
        variant === "bar"
          ? "border-b border-border px-4 py-2 text-sidebar-meta md:hidden"
          : "hidden px-1 pb-1.5 text-xs md:flex",
        variant === "bar" &&
          (summary.quiet ? "bg-coral-wash" : "bg-honey-wash"),
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
        <NameList names={names} />
        {title ? (
          <span data-testid="running-strip-title">
            {" · "}
            {title}
            {progressText(progress) ? ` · ${progressText(progress)}` : null}
          </span>
        ) : (
          <>
            {" "}
            <span className={summary.quiet ? "text-coral-ink" : undefined}>
              {summary.verb}
            </span>
          </>
        )}
      </span>
      {progress ? (
        <span className="ml-auto flex shrink-0">
          <ProgressSegments
            progress={progress}
            live
            size={variant === "bar" ? "bar" : "rail"}
          />
        </span>
      ) : null}
      {!summary.quiet && !progress && <Dots tone="work" />}
      {timing && (
        <span
          className={cn(
            "shrink-0 font-mono text-2xs",
            !progress && "ml-auto",
            summary.quiet ? "text-coral-ink" : "text-muted-foreground",
          )}
        >
          {timing}
        </span>
      )}
    </div>
  );
  if (!typingLine) {
    return strip;
  }
  // Both: the agents at work first, then the people typing beneath them.
  return (
    <>
      {strip}
      {typingLine}
    </>
  );
}

import * as React from "react";
import { Check, CircleAlert, Loader2 } from "lucide-react";

import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { useNow } from "@/shared/lib/useNow";
import { AnimatedCount } from "@/shared/ui/AnimatedCount";
import {
  ActivityRow,
  ActivityRowContent,
  ActivityRowLabel,
  splitActivityRowCountedObject,
  type ActivityRowStats,
} from "./activityRenderClasses/ActivityRow";
import { TranscriptActivityItem } from "./activityRenderClasses/TranscriptActivityItem";
import { TranscriptTimestamp } from "./activityRenderClasses/TranscriptTimestamp";
import type { AgentTranscriptIdentityProps } from "./activityRenderClasses/types";
import { useAgentSessionTranscriptVariant } from "./agentSessionTranscriptContext";
import type { TranscriptToolRun } from "./agentSessionTranscriptGrouping";
import { buildCompactToolSummary } from "./agentSessionToolSummary";
import {
  summarizeToolRunHeadline,
  summarizeToolRunStatus,
  toolRunCompletedAtMs,
  toolRunElapsedMs,
  toolRunStartedAtMs,
  type ToolRunPhase,
} from "./agentSessionToolRunSummary";
import {
  formatDurationMs,
  formatTranscriptTimestampTitle,
} from "./agentSessionUtils";
import { hasFileEditLineDiff } from "./FileEditDiffView";
import { useTranscriptAnimationEnabled } from "./transcriptAnimationPreference";
import { useTranscriptTimestampsEnabled } from "./transcriptTimestampPreference";

type ToolRunStep = TranscriptToolRun["items"][number];

/**
 * Cadence of the live elapsed clock. Only mounted while a run is executing, so
 * a settled transcript never ticks.
 */
const LIVE_ELAPSED_TICK_MS = 1000;

/**
 * One card for one run of consecutive tool steps.
 *
 * The card is the run's single row: it mutates in place as steps stream in
 * (VISION_ACTIVITY "mutate in place") rather than leaving a trail of status
 * rows. Its header is the run's verb/object/outcome sentence plus an aggregate
 * status glyph and timing; its body is one row per step, each reusing the
 * ordinary tool item rendering so shell blocks, diffs, sent-message previews,
 * and image previews all keep working.
 */
export function AgentSessionToolRunCard({
  agentAvatarUrl,
  agentName,
  agentPubkey,
  profiles,
  run,
}: AgentTranscriptIdentityProps & {
  profiles?: UserProfileLookup;
  run: TranscriptToolRun;
}) {
  const variant = useAgentSessionTranscriptVariant();
  const timestampsEnabled = useTranscriptTimestampsEnabled();
  const isCompactPreview = variant === "compactPreview";
  const aggregate = summarizeToolRunStatus(run.items);
  const headline = summarizeToolRunHeadline(run.items, aggregate);
  const stats = useToolRunEditStats(run.items);
  const { expanded, setExpanded } = useToolRunDisclosure(aggregate.phase);

  // The compact preview is a non-interactive activity thumbnail, so a run reads
  // there exactly as it did before cards existed: an uncontrolled, collapsed
  // summary row with no live clock and no per-row timestamp. Everywhere else
  // the card drives its own disclosure.
  const disclosure = isCompactPreview
    ? {}
    : { onOpenChange: setExpanded, open: expanded };

  return (
    <div data-run-phase={aggregate.phase} data-tool-run-id={run.id}>
      <ActivityRow
        className="flex flex-col gap-0.5"
        openToneScope="summary"
        testId="transcript-tool-run-card"
        title={formatTranscriptTimestampTitle(run.timestamp)}
        {...disclosure}
      >
        <ToolRunStatusGlyph
          errorCount={aggregate.errorCount}
          phase={aggregate.phase}
        />
        <ToolRunHeadlineLabel
          detail={headline.detail}
          object={headline.object}
          stats={stats}
          verb={headline.verb}
        />
        {isCompactPreview ? null : (
          <ToolRunTiming
            isRunning={aggregate.phase === "running"}
            items={run.items}
          />
        )}
        <ActivityRowContent className="flex flex-col gap-0.5">
          {run.items.map((item) => (
            <ToolRunStepRow
              agentAvatarUrl={agentAvatarUrl}
              agentName={agentName}
              agentPubkey={agentPubkey}
              item={item}
              key={item.id}
              profiles={profiles}
            />
          ))}
        </ActivityRowContent>
      </ActivityRow>
      {timestampsEnabled && !isCompactPreview ? (
        <div
          className="mt-0.5 flex justify-start"
          data-testid="transcript-row-timestamp"
        >
          <TranscriptTimestamp timestamp={run.timestamp} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Disclosure state for a run card.
 *
 * A live run is open so the reader watches work happen; when it settles the
 * card collapses itself and hands the space back to the conversation — unless
 * the run failed, in which case it stays open (a buried error is a broken
 * feed). Once the reader has touched the card their choice wins over both
 * rules for the rest of the run's life.
 */
function useToolRunDisclosure(phase: ToolRunPhase) {
  const [userChoice, setUserChoice] = React.useState<boolean | null>(null);
  const expanded = userChoice ?? phase !== "done";

  // `<details>` fires `toggle` for programmatic `open` changes as well as
  // clicks. Without this guard the card's own auto-expand would be recorded as
  // a reader choice and would then pin the card open forever, so a completed
  // run would never collapse. Only a toggle that DISAGREES with the state we
  // last rendered can have come from the reader.
  const renderedRef = React.useRef(expanded);
  React.useLayoutEffect(() => {
    renderedRef.current = expanded;
  }, [expanded]);

  const setExpanded = React.useCallback((open: boolean) => {
    if (open === renderedRef.current) return;
    setUserChoice(open);
  }, []);

  return { expanded, setExpanded };
}

/**
 * Aggregate +/- across the run's real line diffs. Runs that edited nothing
 * report no stats rather than a misleading "+0 -0".
 */
function useToolRunEditStats(items: ToolRunStep[]): ActivityRowStats | null {
  return React.useMemo(() => {
    let additions = 0;
    let deletions = 0;
    let sawDiff = false;

    for (const item of items) {
      if (item.isError) continue;
      const diff = buildCompactToolSummary(item).fileEditDiff;
      if (!diff || !hasFileEditLineDiff(diff)) continue;
      sawDiff = true;
      additions += diff.additions;
      deletions += diff.deletions;
    }

    return sawDiff ? { additions, deletions } : null;
  }, [items]);
}

/**
 * Aggregate outcome glyph: spinner while any step executes, check when the run
 * finished clean, error mark when any step failed.
 */
function ToolRunStatusGlyph({
  errorCount,
  phase,
}: {
  errorCount: number;
  phase: ToolRunPhase;
}) {
  if (phase === "running") {
    return (
      <>
        <Loader2
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/70"
        />
        <span className="sr-only">Running</span>
      </>
    );
  }

  if (phase === "error") {
    return (
      <>
        <CircleAlert
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-destructive"
        />
        <span className="sr-only">
          {errorCount === 1 ? "1 step failed" : `${errorCount} steps failed`}
        </span>
      </>
    );
  }

  return (
    <>
      <Check
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
      />
      <span className="sr-only">Done</span>
    </>
  );
}

/**
 * The run's headline sentence. A leading count in the object phrase rolls
 * through AnimatedCount so a run growing from "Read 3 files" to "Read 4 files"
 * reads as an increment rather than a silent swap.
 */
function ToolRunHeadlineLabel({
  detail,
  object,
  stats,
  verb,
}: {
  detail: string | null;
  object: string | null;
  stats: ActivityRowStats | null;
  verb: string;
}) {
  const animationsEnabled = useTranscriptAnimationEnabled();
  const counted =
    animationsEnabled && object ? splitActivityRowCountedObject(object) : null;

  const objectNode = counted ? (
    <>
      <AnimatedCount value={counted.count} />
      {counted.rest}
    </>
  ) : (
    object
  );

  return (
    <>
      <ActivityRowLabel
        object={objectNode}
        openToneScope="summary"
        stats={stats}
        verb={verb}
      />
      {detail ? (
        <span className="shrink-0 text-xs text-muted-foreground/60">
          {detail}
        </span>
      ) : null}
    </>
  );
}

/**
 * Run timing: a live counter while the run executes, the finished span once it
 * settles. Split so only the live branch mounts the ticking clock.
 */
function ToolRunTiming({
  isRunning,
  items,
}: {
  isRunning: boolean;
  items: ToolRunStep[];
}) {
  if (isRunning) {
    return <ToolRunLiveElapsed items={items} />;
  }

  const startedAt = toolRunStartedAtMs(items);
  const completedAt = toolRunCompletedAtMs(items);
  // Nothing is executing but a step never reported a completion instant: the
  // span is unknowable, so report nothing rather than a number frozen against
  // whenever this happened to render.
  if (startedAt === null || completedAt === null) return null;

  return <ToolRunTimingText ms={completedAt - startedAt} />;
}

function ToolRunLiveElapsed({ items }: { items: ToolRunStep[] }) {
  const now = useNow(LIVE_ELAPSED_TICK_MS);
  return <ToolRunTimingText ms={toolRunElapsedMs(items, now)} />;
}

function ToolRunTimingText({ ms }: { ms: number | null }) {
  const formatted = ms === null ? null : formatDurationMs(ms);
  if (!formatted) return null;

  return (
    <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
      {formatted}
    </span>
  );
}

/**
 * One step inside an expanded run. Reuses the ordinary tool item rendering so
 * every render class keeps its own presentation; a failed step additionally
 * carries a left rule so the eye lands on it without hunting.
 */
function ToolRunStepRow({
  agentAvatarUrl,
  agentName,
  agentPubkey,
  item,
  profiles,
}: AgentTranscriptIdentityProps & {
  item: ToolRunStep;
  profiles?: UserProfileLookup;
}) {
  const failed = item.isError || item.status === "failed";

  return (
    <div
      className={cn(
        "min-w-0",
        failed &&
          "rounded-sm border-l-2 border-destructive/60 bg-destructive/5 pl-1.5",
      )}
      data-step-failed={failed ? "true" : undefined}
      data-testid="transcript-tool-run-step"
    >
      <TranscriptActivityItem
        agentAvatarUrl={agentAvatarUrl}
        agentName={agentName}
        agentPubkey={agentPubkey}
        item={item}
        profiles={profiles}
      />
    </div>
  );
}

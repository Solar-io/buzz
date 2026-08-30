import { useEffect, useRef } from "react";
import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/ChannelTimeline";
import {
  observerFrameSummary,
  observerKindLabel,
  type ObserverFrame,
} from "../lib/observerEvents";

function frameTime(frame: ObserverFrame): string {
  let ms = frame.timestamp ? Date.parse(frame.timestamp) : Number.NaN;
  if (Number.isNaN(ms)) {
    ms = frame.createdAt * 1000;
  }
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The DM right panel the desktop calls the agent session view: a live tail
 * of the agent's thinking/activity (observer frames). Frames arrive
 * NIP-44-encrypted to the owner; when the local key is not the owner the
 * panel says so instead of showing garbage.
 */
export function AgentActivityPanel({
  agentPubkey,
  agentName,
  profile,
  frames,
  lockedCount,
  connected,
}: {
  agentPubkey: string;
  agentName: string;
  profile?: Profile;
  frames: ObserverFrame[];
  lockedCount: number;
  connected: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastId = frames[frames.length - 1]?.id ?? "";
  useEffect(() => {
    if (lastId !== "") {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [lastId]);

  return (
    // Same docked-sheet contract as ThreadPanel: full-screen below lg,
    // resizable right pane at lg+ (its width rides the same CSS variable).
    <aside
      className="fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:static lg:inset-auto lg:z-auto lg:w-[var(--thread-width)] lg:shrink-0 lg:border-l lg:border-border lg:pt-0"
      data-agent-panel={agentPubkey}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-[#272736] px-4">
        <AuthorAvatar
          pubkey={agentPubkey}
          label={agentName}
          picture={profile?.avatar}
          size="sm"
        />
        <span className="text-base font-semibold">Thinking</span>
        <span className="text-xs text-muted-foreground">{agentName}</span>
        <span
          className={
            "ml-auto inline-block h-2 w-2 rounded-full " +
            (connected ? "bg-emerald-500" : "bg-muted-foreground/40")
          }
          title={connected ? "Live" : "Connecting…"}
        />
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {frames.length === 0 && lockedCount === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {connected
              ? "No live activity yet. Mention this agent to watch its next turn."
              : "Connecting to the relay…"}
          </p>
        )}
        {frames.length === 0 && lockedCount > 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            🔒 {lockedCount} activity{" "}
            {lockedCount === 1 ? "frame is" : "frames are"} encrypted for the
            owner — unlock with the owner key to read them.
          </p>
        )}
        <ol className="space-y-1.5">
          {frames.map((frame) => (
            <li
              key={frame.id}
              className="rounded-lg border border-border/60 bg-card/60 px-2.5 py-1.5"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {frameTime(frame)}
                </span>
                <span className="text-xs font-semibold">
                  {observerKindLabel(frame.kind)}
                </span>
              </div>
              {observerFrameSummary(frame) && (
                <p className="mt-0.5 break-words text-sm text-muted-foreground">
                  {observerFrameSummary(frame)}
                </p>
              )}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}

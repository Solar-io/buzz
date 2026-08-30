import { useEffect, useMemo, useRef } from "react";
import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/ChannelTimeline";
import {
  transcriptFromFrames,
  type ObserverFrame,
  type TranscriptEntry,
} from "../lib/observerEvents";

function entryTime(at: number): string {
  return new Date(at * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusColor(status: string): string {
  if (status === "completed") {
    return "text-emerald-500";
  }
  if (status === "failed" || status === "error") {
    return "text-red-400";
  }
  return "text-amber-400";
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  if (entry.type === "turn") {
    return (
      <li className="flex items-center gap-2 py-1 text-xs text-muted-foreground/70">
        <span className="h-px flex-1 bg-border" />
        Turn · {entryTime(entry.at)}
        <span className="h-px flex-1 bg-border" />
      </li>
    );
  }
  if (entry.type === "tool") {
    return (
      <li className="flex items-baseline gap-2 rounded-lg px-1 py-0.5 text-sm">
        <span aria-hidden="true">🔧</span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {entry.title}
        </span>
        <span className={`shrink-0 text-xs ${statusColor(entry.status)}`}>
          {entry.status}
        </span>
      </li>
    );
  }
  return (
    <li className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
      <div className="mb-0.5 text-xs font-medium text-muted-foreground">
        💭 Thinking · {entryTime(entry.at)}
      </div>
      <p className="break-words whitespace-pre-wrap text-sm leading-5 text-muted-foreground">
        {entry.text.trim()}
      </p>
    </li>
  );
}

/**
 * The DM right panel the desktop calls the agent session view: a curated
 * transcript (thinking text + tool rows — raw RPC frames are suppressed),
 * the same treatment as the desktop's "thinking on aeryn" enhancement.
 * Frames arrive NIP-44-encrypted to the owner; a locked count shows when the
 * local key cannot decrypt them.
 */
export function AgentActivityPanel({
  agentPubkey,
  agentName,
  profile,
  frames,
  lockedCount,
  connected,
  mobileOpen,
  onCloseMobile,
  onSelectThreadTab,
}: {
  agentPubkey: string;
  agentName: string;
  profile?: Profile;
  frames: ObserverFrame[];
  lockedCount: number;
  connected: boolean;
  /** Below lg the panel is a deliberate sheet opened from the chat header. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /** DMs offer a Thinking ↔ Replies switch in the header. */
  onSelectThreadTab?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { entries, suppressed } = useMemo(
    () => transcriptFromFrames(frames),
    [frames],
  );
  const lastId = frames[frames.length - 1]?.id ?? "";
  useEffect(() => {
    if (lastId !== "") {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [lastId, entries.length]);

  return (
    // lg+: docked right pane (width rides the shared --thread-width var).
    // Below lg: a closable full-screen sheet the user opens from the header —
    // never an automatic cover over the conversation.
    <aside
      className={
        mobileOpen
          ? "fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:hidden"
          : "hidden lg:static lg:flex lg:w-[var(--thread-width)] lg:shrink-0 lg:flex-col lg:border-l lg:border-border"
      }
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
        {onSelectThreadTab && (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onSelectThreadTab}
          >
            Replies
          </button>
        )}
        <span
          className={
            "ml-auto inline-block h-2 w-2 rounded-full " +
            (connected ? "bg-emerald-500" : "bg-muted-foreground/40")
          }
          title={connected ? "Live" : "Connecting…"}
        />
        <button
          type="button"
          aria-label="Close thinking panel"
          className="rounded p-1 text-sm text-muted-foreground hover:bg-accent lg:hidden"
          onClick={onCloseMobile}
        >
          ✕
        </button>
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
          {entries.map((entry) => (
            <TranscriptRow key={entry.id} entry={entry} />
          ))}
        </ol>
        {suppressed > 0 && (
          <p className="pt-2 text-center text-xs text-muted-foreground/50">
            {suppressed} internal event{suppressed === 1 ? "" : "s"} filtered
          </p>
        )}
      </div>
    </aside>
  );
}

import { useCallback, useEffect, useMemo, useRef } from "react";
import { BarChart3, Brain } from "lucide-react";
import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import {
  applyInputFollowScroll,
  armFollowInput,
  createInputFollowState,
  forceInputFollow,
} from "@/features/agents/lib/scrollFollow";
import {
  transcriptFromFrames,
  type AgentWorkingState,
  type ObserverFrame,
  type TranscriptEntry,
} from "../lib/observerEvents";
import { useTick, WorkingBadge } from "./WorkingBadge";

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
  if (entry.type === "toolBurst") {
    return (
      <li className="flex items-baseline gap-2 rounded-lg px-1 py-0.5 text-sm text-muted-foreground">
        <span aria-hidden="true">🔧</span>
        <span className="font-medium">
          Ran {entry.count} tool call{entry.count === 1 ? "" : "s"}
        </span>
      </li>
    );
  }
  if (entry.type === "usage") {
    return (
      <li className="flex items-baseline gap-2 rounded-lg px-1 py-0.5 text-sm text-muted-foreground">
        <BarChart3
          aria-hidden="true"
          className="h-3.5 w-3.5 text-muted-foreground"
        />
        <span className="font-medium tabular-nums">{entry.text}</span>
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
        <Brain
          aria-hidden="true"
          className="mr-1 inline h-3.5 w-3.5 text-muted-foreground"
        />
        Thinking · {entryTime(entry.at)}
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
  working,
  mobileOpen,
  onCloseMobile,
  onCloseDesktop,
  onSelectThreadTab,
}: {
  agentPubkey: string;
  agentName: string;
  profile?: Profile;
  frames: ObserverFrame[];
  lockedCount: number;
  connected: boolean;
  /** Turn-in-flight state with start time (drives the Working · timer). */
  working: AgentWorkingState;
  /** Below lg the panel is a deliberate sheet opened from the chat header. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /** Collapses the desktop right pane entirely. */
  onCloseDesktop?: () => void;
  /** DMs offer a Thinking ↔ Replies switch in the header. */
  onSelectThreadTab?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow-the-tail state (see lib/scrollFollow.ts — the InputFollowState
  // engine the timeline uses, ported here 2026-09-15, D-027): tailing pauses
  // on a reader's upward INPUT (touch/wheel/scrollbar/scroll keys — armed by
  // the capture-phase listeners below), never on scroll deltas, so the pane's
  // own settling (the double-rAF tail, the ResizeObserver re-pin, late-sizing
  // content) cannot pause the tail the way the old delta engine did.
  // Scrolling back to the bottom resumes.
  const followRef = useRef(createInputFollowState(true));
  /** Pending rAF of the geometry re-pin (coalesced like the timeline's). */
  const pinRafRef = useRef<number | null>(null);
  const { entries, suppressed } = useMemo(
    () => transcriptFromFrames(frames),
    [frames],
  );
  // Auto-tail: land on the NEWEST entry when the panel mounts with retained
  // history, when the agent switches, and as new frames stream in. Double-rAF
  // (same pattern as the chat timeline): the first frame commits layout for
  // freshly rendered rows, the second measures the final scrollHeight —
  // scrolling synchronously in the effect lands a render short. Tail scrolls
  // happen ONLY while following — a reader scrolled up is never yanked back.
  const hasThinking = useMemo(
    () => entries.some((entry) => entry.type === "thought"),
    [entries],
  );
  const lastId = frames[frames.length - 1]?.id ?? "";
  const agentKey = agentPubkey;
  const lastAgentKeyRef = useRef(agentKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries.length and agentKey are deliberate scroll re-triggers (a new retained entry, an agent switch), not reads inside the effect
  useEffect(() => {
    if (lastId === "") {
      return;
    }
    // A fresh agent/mount always re-lands on the newest entry. Keyed on the
    // agent change itself (not per-frame — a per-frame reset would defeat
    // the pause).
    if (lastAgentKeyRef.current !== agentKey) {
      lastAgentKeyRef.current = agentKey;
      forceInputFollow(followRef.current);
      followRef.current.prevScrollTop = 0;
    }
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const scrollToEnd = () => {
      if (!followRef.current.follow) {
        return;
      }
      scroller.scrollTo({ top: scroller.scrollHeight });
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(scrollToEnd));
    return () => cancelAnimationFrame(raf);
  }, [lastId, entries.length, agentKey]);
  // Follow tick + reader-input arm (the timeline's pattern, D-027): the
  // scroller div is its own wrapper — native CAPTURE-phase listeners attached
  // in an effect, not React props (React's onScroll cannot capture-listen for
  // descendant scroll events, and a prop re-attach churns on every render).
  // The scroll handler processes ONLY the pane scroller's own events, read
  // off event.target's native metrics; inner scrollers (a horizontal code
  // block inside a thinking entry) are not pane scrolls and are skipped —
  // the pane equivalent of the timeline's scrollHeight-clientHeight<2 rule,
  // stricter because a plain-div pane has exactly one scroller that matters.
  const handleFollowScroll = useCallback((event: Event) => {
    const el = event.target as HTMLElement | null;
    if (!el || el !== scrollRef.current) {
      return;
    }
    applyInputFollowScroll(
      followRef.current,
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
      performance.now(),
    );
  }, []);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const arm = () => armFollowInput(followRef.current, performance.now());
    const armForPointer = (event: PointerEvent) => {
      if (event.target === scroller) {
        arm();
      }
    };
    const armForScrollKey = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !(event.target instanceof Node) ||
        !scroller.contains(event.target) ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            event.target.closest(
              "input, textarea, select, [contenteditable='true']",
            ) !== null))
      ) {
        return;
      }
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "End" ||
        event.key === "Home" ||
        event.key === "PageDown" ||
        event.key === "PageUp" ||
        event.key === " "
      ) {
        arm();
      }
    };
    scroller.addEventListener("touchmove", arm, {
      capture: true,
      passive: true,
    });
    scroller.addEventListener("wheel", arm, { capture: true, passive: true });
    scroller.addEventListener("pointerdown", armForPointer, {
      capture: true,
      passive: true,
    });
    window.addEventListener("keydown", armForScrollKey, true);
    scroller.addEventListener("scroll", handleFollowScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      scroller.removeEventListener("touchmove", arm, { capture: true });
      scroller.removeEventListener("wheel", arm, { capture: true });
      scroller.removeEventListener("pointerdown", armForPointer, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener("keydown", armForScrollKey, true);
      scroller.removeEventListener("scroll", handleFollowScroll, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [handleFollowScroll]);
  // Geometry settle (the timeline's pattern, D-027): while following, ANY
  // geometry change re-pins the bottom — the panel's frames stream in like
  // the timeline's did, and late-sizing content (media, wrapped code) lands
  // seconds after the double-rAF tail. The rAF coalesces the burst of
  // observer callbacks. Not following → no pin, so a reader scrolled up is
  // never yanked by a resize.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const pin = () => {
      if (!followRef.current.follow || pinRafRef.current !== null) {
        return;
      }
      pinRafRef.current = requestAnimationFrame(() => {
        pinRafRef.current = null;
        const el = scrollRef.current;
        if (el && followRef.current.follow) {
          el.scrollTo({ top: el.scrollHeight });
        }
      });
    };
    const observer = new ResizeObserver(pin);
    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content instanceof HTMLElement) {
      observer.observe(content);
    }
    return () => {
      observer.disconnect();
      if (pinRafRef.current !== null) {
        cancelAnimationFrame(pinRafRef.current);
        pinRafRef.current = null;
      }
    };
  }, []);
  useTick(working.working);

  return (
    // lg+: docked right pane (width rides the shared --thread-width var).
    // Below lg: a closable full-screen sheet the user opens from the header —
    // never an automatic cover over the conversation.
    <aside
      className={
        mobileOpen
          ? // Overlay below lg; at lg the SAME open state docks as the
            // right pane (lg:hidden here would make the 🧠 reopen button
            // dead on desktop — the overlay and the dock must compose).
            "fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:static lg:inset-auto lg:z-auto lg:w-[var(--thread-width)] lg:shrink-0 lg:border-l lg:border-border lg:pt-0"
          : "hidden lg:static lg:flex lg:w-[var(--thread-width)] lg:shrink-0 lg:flex-col lg:border-l lg:border-border"
      }
      data-agent-panel={agentPubkey}
      data-custom-content-pane="thinking"
      data-thinking-pane
    >
      {/* The header bar is gone (Sam, 2026-09-22): the avatar and the word
          "Thinking" were restating what the pane's own chip and the DM you
          opened it from already say. What was in that bar and is NOT
          decoration is preserved below — the Replies switch, the mobile
          close, and the working badge — as a floating strip. Each keeps its
          OWN breakpoint: see the note on the strip itself for why the Replies
          switch cannot inherit the close's `lg:hidden`. */}
      <div
        ref={scrollRef}
        className="buzz-channel-activity-scrollbar relative min-h-0 flex-1 overflow-y-auto p-3"
      >
        {/* Two controls, two different reachability problems, so they do NOT
            share a breakpoint.

            The CLOSE only matters below lg, where this pane is a full-screen
            sheet covering the composer — whose own brain toggle is therefore
            underneath it and unreachable. At lg the pane is docked beside the
            composer, that toggle is visible, and this hides.

            The REPLIES switch is the opposite case and must stay visible at
            EVERY width. It is the only route from this pane to the thread in a
            DM that has both a thread and an agent (`onSelectThreadTab` is
            passed only then), and the reverse route lives on the thread pane.
            Gating it to `lg:hidden` stranded desktop: a reader who switched to
            Replies had no way back to Thinking. It was an unqualified child of
            the old header bar for exactly this reason. */}
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
          {onSelectThreadTab && (
            <button
              type="button"
              className="rounded-md bg-card/90 px-2 py-1 text-sm text-muted-foreground backdrop-blur-sm hover:bg-accent hover:text-foreground"
              onClick={onSelectThreadTab}
            >
              Replies
            </button>
          )}
          <button
            type="button"
            aria-label="Close thinking panel"
            className="rounded-md bg-card/90 p-1 text-sm text-muted-foreground backdrop-blur-sm hover:bg-accent lg:hidden"
            onClick={() => {
              onCloseMobile();
              onCloseDesktop?.();
            }}
          >
            ✕
          </button>
        </div>
        {working.working && working.startedAt !== null && (
          <div className="mb-2 flex items-center gap-2">
            <AuthorAvatar
              pubkey={agentPubkey}
              label={agentName}
              picture={profile?.avatar}
              size="sm"
            />
            <WorkingBadge startedAt={working.startedAt} />
          </div>
        )}
        {/* The portrait lives over the CHAT column now (AgentPortraitOverlay,
            rendered by the DM route): a stationary overlay, not a block at
            the top of this scroll area, where it was only visible at one
            scroll position (Sam's placement verdict, 2026-09-14). The small
            header chip stays as the in-pane identity anchor. */}
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
        {/*
          An agent whose harness never emits `agent_thought_chunk` renders a
          panel of tool rows and turn dividers with no thinking, which is
          indistinguishable from a broken feed — it was reported as one. Say
          so instead. The condition is a fact about what arrived, not a guess:
          frames were received and rendered, and none of them were thoughts.
        */}
        {frames.length > 0 && entries.length > 0 && !hasThinking && (
          <p className="pt-3 text-center text-xs text-muted-foreground/70">
            This agent reports tool calls and turns but does not stream its
            reasoning, so there is no thinking text to show.
          </p>
        )}
        {suppressed > 0 && (
          <p className="pt-2 text-center text-xs text-muted-foreground/50">
            {suppressed} internal event{suppressed === 1 ? "" : "s"} filtered
          </p>
        )}
        {/* TEMPORARY feed diagnostics (remove once the indicator report is
            resolved): raw frames in / locked / shown / connection state. */}
        <p className="pt-3 text-center text-xs text-muted-foreground/60">
          feed: {frames.length} frames · {lockedCount} locked · {entries.length}{" "}
          shown · {connected ? "live" : "connecting"}
        </p>
      </div>
    </aside>
  );
}

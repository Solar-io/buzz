import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  Radio,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { ChannelMember, Profile } from "@/features/channels/hooks";
import {
  timelineMessageFromEvent,
  type TimelineMessage,
} from "@/features/channels/lib/messageBuffer.ts";
import { Composer } from "@/features/channels/ui/Composer";
import { MessageRow } from "@/features/channels/ui/MessageRow";
import type { AgentSpeechPlayer } from "@/features/voice/useAgentSpeechPlayer";
import { cn } from "@/shared/lib/cn";
import type { StageEntryMode } from "../lib/stageLauncher.ts";
import { useStage, type HuddleSpeechLike } from "../useStage.ts";
import { useStageSession } from "../useStageSession.ts";
import { useStageImage } from "./useStageImage.ts";

/** Landscape at >= 1024 px: chat 1/3 left | image 2/3 right. Else stacked. */
export const STAGE_SPLIT_QUERY =
  "(min-width: 1024px) and (orientation: landscape)";
const CONTROLS_IDLE_MS = 3_000;

function useStageLayout(): "split" | "stacked" {
  const query = () =>
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia(STAGE_SPLIT_QUERY).matches;
  const [split, setSplit] = useState(query);
  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") return;
    const media = globalThis.matchMedia(STAGE_SPLIT_QUERY);
    const onChange = () => setSplit(media.matches);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);
  return split ? "split" : "stacked";
}

type FullscreenDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
};
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

function fullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as FullscreenDoc;
  return Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

/** Best-effort, always from a tap/key handler; Stage never depends on it. */
function toggleFullscreen(element: HTMLElement | null) {
  const doc = document as FullscreenDoc;
  try {
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      void doc.exitFullscreen?.();
      return;
    }
    const target = element as FullscreenEl | null;
    if (target?.requestFullscreen) void target.requestFullscreen();
    else target?.webkitRequestFullscreen?.();
  } catch {
    // Unsupported (iPhone Safari): the overlay is already full-viewport.
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable
  );
}

function ControlButton({
  label,
  onClick,
  pressed,
  children,
  testId,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/60"
    >
      {children}
    </button>
  );
}

export interface StageViewProps {
  openId: string;
  /** The shell's open channel — Stage overlays it (and posts into it). */
  channelId: string | null;
  messages: readonly TimelineMessage[];
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  send: ComponentProps<typeof Composer>["send"];
  selfPubkey: string | null;
  player: AgentSpeechPlayer;
  entryMode: StageEntryMode;
  /** Entered by a tap that already unlocked audio (skip "Tap to start"). */
  gestured: boolean;
  huddleSpeech?: HuddleSpeechLike | null;
  /** The session lives in another channel: point the shell at it. */
  onChannel: (channelId: string) => void;
  onExit: () => void;
}

/**
 * The Stage overlay (design §8, §15): a full-viewport presentation over the
 * channel. Portrait/narrow stacks image (2/3) above chat (1/3); landscape
 * >= 1024 px splits chat (1/3, left) | image (2/3, right).
 */
export function StageView(props: StageViewProps) {
  const {
    openId,
    channelId,
    messages,
    player,
    entryMode,
    gestured,
    huddleSpeech,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(gestured);
  const layout = useStageLayout();
  const { session, status, historyLoaded, historyEvents } = useStageSession(
    openId,
    messages,
  );
  const stage = useStage({
    session,
    historyLoaded,
    player,
    entryMode,
    started,
    huddleSpeech,
  });
  const onChannel = props.onChannel;
  useEffect(() => {
    if (session && session.channelId !== channelId)
      onChannel(session.channelId);
  }, [session, channelId, onChannel]);

  // Keyboard: ←/→ prev/next, M mute, F fullscreen, Esc exit (the browser
  // leaves native fullscreen on Esc itself, before this ever sees it).
  const keys = useRef({ stage, onExit: props.onExit });
  keys.current = { stage, onExit: props.onExit };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey) {
        return;
      }
      const { stage: s, onExit } = keys.current;
      if (event.key === "Escape") onExit();
      else if (event.key === "ArrowRight") s.next();
      else if (event.key === "ArrowLeft") s.prev();
      else if (event.key === "m" || event.key === "M") s.toggleMuted();
      else if (event.key === "f" || event.key === "F") {
        toggleFullscreen(rootRef.current);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [controlsVisible, setControlsVisible] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poke = () => {
    setControlsVisible(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(
      () => setControlsVisible(false),
      CONTROLS_IDLE_MS,
    );
  };
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const current = stage.current;
  const image = useStageImage(current?.imageUrl ?? null);
  const released = stage.state?.releasedIds;
  const showingIds = useMemo(
    () => new Set(session?.showings.map((s) => s.eventId) ?? []),
    [session],
  );

  // Chat: this session's window of the channel, top-level only, with the
  // rows of not-yet-released showings hidden (text and image land together).
  const chat = useMemo(() => {
    if (!session) return [];
    const byId = new Map<string, TimelineMessage>();
    for (const event of historyEvents) {
      const message = timelineMessageFromEvent(event);
      if (message) byId.set(message.id, message);
    }
    for (const message of messages) byId.set(message.id, message);
    return Array.from(byId.values())
      .filter(
        (m) =>
          m.channelId === session.channelId &&
          m.createdAt >= session.openedAt &&
          m.id !== session.openId &&
          !m.deleted &&
          m.rootId === null &&
          m.replyToId === null &&
          (!showingIds.has(m.id) || released?.has(m.id) === true),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [session, historyEvents, messages, showingIds, released]);

  const chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (chat.length > 0) chatEnd.current?.scrollIntoView?.({ block: "end" });
  }, [chat]);

  const title = session?.title ?? "Stage";
  const total = stage.state?.showings.length ?? 0;
  const position = (stage.state?.currentIndex ?? -1) + 1;
  const behind =
    stage.state !== null &&
    stage.state.currentIndex < stage.state.releasedCount - 1;
  const showRestart =
    entryMode === "live" && (stage.state?.currentIndex ?? 0) > 0;

  const chatPane = (
    <section
      data-testid="stage-chat-pane"
      aria-label="Stage chat"
      className={cn(
        "flex min-h-0 flex-col bg-background text-foreground",
        layout === "split" ? "border-r border-white/10" : "border-t",
      )}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div
            data-testid="stage-position"
            className="text-xs text-muted-foreground tabular-nums"
          >
            {position}/{total}
          </div>
        </div>
        <button
          type="button"
          data-testid="stage-mute"
          aria-pressed={stage.muted}
          aria-label={stage.muted ? "Unmute Stage" : "Mute Stage"}
          title="Mute (M)"
          onClick={stage.toggleMuted}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted"
        >
          {stage.muted ? (
            <VolumeX className="h-6 w-6" aria-hidden />
          ) : (
            <Volume2 className="h-6 w-6" aria-hidden />
          )}
        </button>
        <button
          type="button"
          data-testid="stage-exit"
          aria-label="Exit Stage"
          title="Exit (Esc)"
          onClick={props.onExit}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted"
        >
          <X className="h-6 w-6" aria-hidden />
        </button>
      </header>
      <div
        data-testid="stage-chat-list"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {chat.map((message, index) => {
          const previous = chat[index - 1];
          return (
            <MessageRow
              key={message.id}
              message={message}
              profiles={props.profiles}
              grouped={
                previous?.authorPubkey === message.authorPubkey &&
                message.createdAt - previous.createdAt < 300
              }
              replyCount={0}
              active={false}
              reactionGroups={[]}
              selfPubkey={props.selfPubkey}
              showActions={false}
            />
          );
        })}
        <div ref={chatEnd} />
      </div>
      <div className="border-t p-2">
        {session && session.channelId === channelId ? (
          <Composer
            members={props.members}
            profiles={props.profiles}
            send={props.send}
            draftKey={`stage:${session.channelId}`}
            placeholder="Reply…"
          />
        ) : null}
      </div>
    </section>
  );

  const imagePane = (
    <section
      data-testid="stage-image-pane"
      aria-label="Stage image"
      className="relative min-h-0 overflow-hidden bg-black"
      onPointerMove={poke}
      onPointerDown={poke}
    >
      {image.objectUrl ? (
        <img
          key={image.objectUrl}
          data-testid="stage-image"
          data-showing={current?.eventId}
          src={image.objectUrl}
          alt={current?.text || title}
          className="absolute inset-0 h-full w-full object-contain animate-in fade-in duration-300"
        />
      ) : current ? (
        <div
          data-testid="stage-image-loading"
          data-showing={current.eventId}
          className="absolute inset-0 animate-pulse bg-white/5"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
          {status === "missing"
            ? "This Stage could not be found."
            : "Waiting for the first frame…"}
        </div>
      )}
      {stage.audioLocked && !stage.muted ? (
        <button
          type="button"
          data-testid="stage-resume-audio"
          onClick={stage.resumeAudio}
          className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm font-medium text-black shadow"
        >
          Tap to resume audio
        </button>
      ) : null}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-4 transition-opacity",
          controlsVisible
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100",
        )}
      >
        <ControlButton
          label="Previous (←)"
          onClick={stage.prev}
          testId="stage-prev"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </ControlButton>
        <ControlButton
          label="Next (→)"
          onClick={stage.next}
          testId="stage-next"
        >
          <ChevronRight className="h-5 w-5" aria-hidden />
        </ControlButton>
        {behind ? (
          <ControlButton label="Live" onClick={stage.live} testId="stage-live">
            <Radio className="h-5 w-5" aria-hidden />
          </ControlButton>
        ) : null}
        {showRestart ? (
          <ControlButton
            label="From the start"
            onClick={stage.restart}
            testId="stage-restart"
          >
            <RotateCcw className="h-5 w-5" aria-hidden />
          </ControlButton>
        ) : null}
        {fullscreenSupported() ? (
          <ControlButton
            label="Fullscreen (F)"
            onClick={() => toggleFullscreen(rootRef.current)}
            testId="stage-fullscreen"
          >
            <Maximize className="h-5 w-5" aria-hidden />
          </ControlButton>
        ) : null}
      </div>
      {/* Tap the right edge = Next (design §5). */}
      <button
        type="button"
        aria-label="Next"
        tabIndex={-1}
        onClick={stage.next}
        className="absolute inset-y-0 right-0 w-[12%] cursor-e-resize opacity-0"
      />
    </section>
  );

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Stage: ${title}`}
      data-testid="stage-view"
      data-layout={layout}
      className="fixed inset-0 z-50 h-[100dvh] bg-black pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-white"
    >
      {!started ? (
        <div className="flex h-full flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="text-lg font-semibold">{title}</div>
          <button
            type="button"
            data-testid="stage-tap-to-start"
            onClick={() => {
              // Inside the gesture: the only moment iOS lets audio start.
              player.unlock();
              setStarted(true);
            }}
            className="rounded-full bg-white px-8 py-4 text-base font-semibold text-black"
          >
            Tap to start
          </button>
          <button
            type="button"
            onClick={props.onExit}
            className="text-sm text-white/70 underline"
          >
            Back
          </button>
        </div>
      ) : layout === "split" ? (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          {chatPane}
          {imagePane}
        </div>
      ) : (
        <div className="grid h-full grid-rows-[minmax(0,2fr)_minmax(0,1fr)]">
          {imagePane}
          {chatPane}
        </div>
      )}
    </div>
  );
}

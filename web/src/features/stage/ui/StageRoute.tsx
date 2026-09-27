import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Clapperboard, X } from "lucide-react";
import type { ChannelMember, Profile } from "@/features/channels/hooks";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import type { Composer } from "@/features/channels/ui/Composer";
import { useHuddleSession } from "@/features/huddle/HuddleSessionProvider";
import { useAgentSpeechPlayer } from "@/features/voice/useAgentSpeechPlayer";
import {
  launchStage,
  setStageLauncher,
  takeStageEntry,
  type StageEntryMode,
} from "../lib/stageLauncher.ts";
import { StageView } from "./StageView.tsx";

/**
 * "Stage ready — tap to watch" (design §15, Q3): a Stage OPEN that lands
 * live in the conversation being viewed. Only opens that arrive after the
 * conversation was first shown count — history never raises a banner.
 */
export function useStageReadyBanner(
  channelId: string | null,
  messages: readonly TimelineMessage[],
  selfPubkey: string | null,
  activeStageId: string | null,
): {
  banner: { openId: string; title: string } | null;
  dismiss: () => void;
} {
  const seen = useRef<{ channelId: string | null; ids: Set<string> | null }>({
    channelId: null,
    ids: null,
  });
  const [banner, setBanner] = useState<{
    openId: string;
    title: string;
    channelId: string;
  } | null>(null);

  useEffect(() => {
    if (seen.current.channelId !== channelId) {
      seen.current = { channelId, ids: null };
      setBanner(null);
    }
    const opens = messages.filter(
      (m) => m.stage?.op === "open" && m.channelId === channelId,
    );
    if (seen.current.ids === null) {
      // First render of this conversation: everything here is history.
      // Wait for the buffer to be non-empty so a cold cache load is history
      // too, not a burst of "new" opens.
      if (messages.length === 0) return;
      seen.current.ids = new Set(opens.map((m) => m.id));
      return;
    }
    for (const message of opens) {
      if (seen.current.ids.has(message.id)) continue;
      seen.current.ids.add(message.id);
      if (message.authorPubkey === selfPubkey || message.stage?.op !== "open") {
        continue;
      }
      setBanner({
        openId: message.id,
        title: message.stage.title,
        channelId: message.channelId,
      });
    }
  }, [channelId, messages, selfPubkey]);

  const visible =
    banner && banner.channelId === channelId && banner.openId !== activeStageId
      ? banner
      : null;
  return {
    banner: visible ? { openId: visible.openId, title: visible.title } : null,
    dismiss: () => setBanner(null),
  };
}

export function StageReadyBanner({
  title,
  onWatch,
  onDismiss,
}: {
  title: string;
  onWatch: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="stage-ready-banner"
      className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-card px-2 py-1.5 text-sm shadow-lg"
    >
      <button
        type="button"
        data-testid="stage-ready-watch"
        onClick={onWatch}
        className="inline-flex items-center gap-2 rounded-full px-3 py-1 font-medium hover:bg-muted"
      >
        <Clapperboard className="h-4 w-4" aria-hidden />
        <span>Stage ready — tap to watch</span>
        <span className="max-w-48 truncate text-muted-foreground">{title}</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full hover:bg-muted"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * The shell's Stage mount (the ONLY thing `routes/repos.tsx` adds): reads
 * `?stage=<openId>`, owns the speech player, registers the launcher the
 * timeline card calls, shows the "Stage ready" banner, and overlays
 * `StageView` on the open conversation.
 */
export function StageRoute(props: {
  channelId: string | null;
  messages: readonly TimelineMessage[];
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  send: ComponentProps<typeof Composer>["send"];
  selfPubkey: string | null;
}) {
  const { channelId, messages, selfPubkey } = props;
  const stageId = useSearch({
    strict: false,
    select: (search: { stage?: unknown }) =>
      typeof search.stage === "string" ? search.stage : null,
  });
  const navigate = useNavigate();
  const huddle = useHuddleSession();
  const huddleSpeech = huddle.active ? huddle.call.speech : null;
  const player = useAgentSpeechPlayer({ logTag: "[stage]" });
  /** Pushed a history entry for this visit, so Back/exit can pop it. */
  const pushed = useRef(false);
  const [entry, setEntry] = useState<{
    openId: string;
    mode: StageEntryMode;
    gestured: boolean;
  } | null>(null);
  const entryRef = useRef<typeof entry>(null);

  useEffect(
    () =>
      setStageLauncher({
        unlock: () => player.unlock(),
        open: (openId, targetChannel) => {
          pushed.current = true;
          void navigate({
            to: "/repos",
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              c: targetChannel,
              m: undefined,
              view: undefined,
              stage: openId,
            }),
          });
        },
      }),
    [player, navigate],
  );

  // Read the entry (mode / gestured) once per visit.
  useEffect(() => {
    if (!stageId) {
      entryRef.current = null;
      setEntry(null);
      pushed.current = false;
      return;
    }
    // Take the entry OUTSIDE the state updater: updaters run twice under
    // StrictMode, and the second take would read the cold-link default.
    if (entryRef.current?.openId === stageId) return;
    const next = { openId: stageId, ...takeStageEntry(stageId) };
    entryRef.current = next;
    setEntry(next);
  }, [stageId]);

  const exit = useCallback(() => {
    if (pushed.current && typeof window !== "undefined") {
      pushed.current = false;
      window.history.back();
      return;
    }
    void navigate({
      to: "/repos",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        stage: undefined,
      }),
      replace: true,
    });
  }, [navigate]);

  const pointAt = useCallback(
    (target: string) =>
      void navigate({
        to: "/repos",
        search: (prev: Record<string, unknown>) => ({ ...prev, c: target }),
        replace: true,
      }),
    [navigate],
  );

  const { banner, dismiss } = useStageReadyBanner(
    channelId,
    messages,
    selfPubkey,
    stageId,
  );

  return (
    <>
      {banner && !stageId && channelId ? (
        <StageReadyBanner
          title={banner.title}
          onWatch={() => {
            dismiss();
            launchStage(banner.openId, channelId, "live");
          }}
          onDismiss={dismiss}
        />
      ) : null}
      {stageId && entry?.openId === stageId ? (
        <StageView
          key={stageId}
          openId={stageId}
          channelId={channelId}
          messages={messages}
          members={props.members}
          profiles={props.profiles}
          send={props.send}
          selfPubkey={selfPubkey}
          player={player}
          entryMode={entry.mode}
          gestured={entry.gestured}
          huddleSpeech={huddleSpeech}
          onChannel={pointAt}
          onExit={exit}
        />
      ) : null}
    </>
  );
}

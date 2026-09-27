import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSpeechPlayer } from "@/features/voice/useAgentSpeechPlayer";
import { decodeStageImage, fetchStageMedia } from "./lib/stageMedia.ts";
import {
  createStagePacer,
  type PacerState,
  type StagePacer,
} from "./lib/stagePacing.ts";
import { createDeckPreloader, type DeckPreloader } from "./lib/stagePreload.ts";
import { createStageFeed, type StageFeed } from "./lib/stageFeed.ts";
import type { StageSession, StageShowing } from "./lib/stageSession.ts";
import type { StageEntryMode } from "./lib/stageLauncher.ts";

export const STAGE_MUTED_KEY = "buzz.stage.muted";

/** The slice of the huddle's agent speech Stage needs (§8 coexistence). */
export interface HuddleSpeechLike {
  interrupt: () => void;
  /** Agent-speech-only suppression; never the user's mute or the room. */
  setSuppressed: (suppressed: boolean) => void;
}

export function loadStageMuted(): boolean {
  try {
    return globalThis.window?.localStorage?.getItem(STAGE_MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveStageMuted(muted: boolean) {
  try {
    globalThis.window?.localStorage?.setItem(
      STAGE_MUTED_KEY,
      muted ? "1" : "0",
    );
  } catch {
    // Private mode / quota: the toggle still works for this visit.
  }
}

const browserClock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle: unknown) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type WakeLockSentinelLike = { release: () => Promise<void> };

/**
 * Screen wake lock while Stage is on (Safari 16.4+), re-acquired when the
 * page becomes visible again, released on exit. Failure is ignored.
 */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const nav = globalThis.navigator as
      | (Navigator & {
          wakeLock?: {
            request: (type: "screen") => Promise<WakeLockSentinelLike>;
          };
        })
      | undefined;
    if (!nav?.wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let alive = true;
    const acquire = () => {
      nav.wakeLock
        ?.request("screen")
        .then((lock) => {
          if (alive) sentinel = lock;
          else void lock.release().catch(() => {});
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}

export interface StageController {
  state: PacerState<StageShowing> | null;
  current: StageShowing | null;
  muted: boolean;
  toggleMuted: () => void;
  /** Voice deck whose AudioContext is suspended/interrupted (iOS). */
  audioLocked: boolean;
  /** Call inside a tap: resume audio after an interruption. */
  resumeAudio: () => void;
  next: () => void;
  prev: () => void;
  live: () => void;
  restart: () => void;
}

/**
 * Wires the pure pacer to the real world (design §7 `useStage.ts`): the
 * speech player, the deck preloader, persisted mute, AudioContext state,
 * the screen wake lock and the huddle's speech. `started` is false until
 * the entry gesture (card tap or "Tap to start") has unlocked audio.
 */
export function useStage(options: {
  session: StageSession | null;
  historyLoaded: boolean;
  player: AgentSpeechPlayer;
  entryMode: StageEntryMode;
  started: boolean;
  huddleSpeech?: HuddleSpeechLike | null;
}): StageController {
  const { session, historyLoaded, player, entryMode, started, huddleSpeech } =
    options;
  const [state, setState] = useState<PacerState<StageShowing> | null>(null);
  const [muted, setMuted] = useState(loadStageMuted);
  const [audioLocked, setAudioLocked] = useState(false);
  const pacerRef = useRef<StagePacer<StageShowing> | null>(null);
  const preloaderRef = useRef<DeckPreloader | null>(null);
  const feedRef = useRef<StageFeed<StageShowing> | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const openId = session?.openId ?? null;
  const author = session?.author ?? "";
  const voice = session?.voice ?? false;
  const ready = started && openId !== null;

  // Pacer + preloader: one per Stage visit (openId), built after the tap.
  useEffect(() => {
    if (!ready) return;
    const preloader = createDeckPreloader({
      fetch: fetchStageMedia,
      decode: decodeStageImage,
    });
    preloaderRef.current = preloader;
    const pacer = createStagePacer<StageShowing>({
      clock: browserClock,
      voice,
      muted: mutedRef.current,
      speak: (showing) => player.speak(showing.speakText, author),
      interrupt: () => player.interrupt(),
      imageReady: (showing) => preloader.whenReady(showing.imageUrl),
      onChange: (next) => {
        setState(next);
        // The next queued showing's image is always first in line.
        const queued = next.showings[next.releasedCount];
        if (queued) preloader.prioritize(queued.imageUrl);
      },
    });
    pacerRef.current = pacer;
    feedRef.current = null;
    player.setMuted(mutedRef.current);
    return () => {
      pacer.dispose();
      preloader.dispose();
      pacerRef.current = null;
      preloaderRef.current = null;
      setState(null);
      // U3: leaving Stage releases the audio context.
      player.dispose();
    };
  }, [ready, voice, author, player]);

  // Palette preload (in order) once the deck is known.
  const palette = session?.palette;
  useEffect(() => {
    if (!ready || !palette) return;
    preloaderRef.current?.enqueue(palette.map((entry) => entry.url));
  }, [ready, palette]);

  // Seed from history once, then feed live arrivals. Showings that arrive
  // live while history is still loading stay live (stageFeed.ts).
  const showings = session?.showings;
  useEffect(() => {
    const pacer = pacerRef.current;
    if (!ready || !pacer || !showings) return;
    if (!feedRef.current) {
      feedRef.current = createStageFeed(pacer, {
        mode: entryMode === "replay" ? "replay" : "late",
        nowSec: Math.floor(Date.now() / 1000),
      });
    }
    feedRef.current.update(showings, historyLoaded);
  }, [showings, historyLoaded, entryMode, ready]);

  // AudioContext state → reading-time pacing + "Tap to resume audio".
  useEffect(() => {
    if (!ready || !voice) return;
    const apply = (contextState: string | null) => {
      const available = contextState === null || contextState === "running";
      setAudioLocked(!available);
      pacerRef.current?.setAudioAvailable(available);
    };
    apply(player.contextState());
    return player.onContextStateChange(apply);
  }, [ready, voice, player]);

  // Huddle coexistence: never talk over a huddle agent in the same tab.
  // Keyed on PRESENCE — the huddle's speech object is rebuilt per render.
  const huddleRef = useRef(huddleSpeech);
  huddleRef.current = huddleSpeech;
  const huddleActive = huddleSpeech != null;
  // A Stage-owned suppression of AGENT speech only: the user's speaker mute
  // and the room's (human) audio are never touched, so a huddle the user
  // muted stays muted after Stage exits, and humans stay audible during it.
  useEffect(() => {
    if (!ready || !huddleActive) return;
    const speech = huddleRef.current;
    speech?.interrupt();
    speech?.setSuppressed(true);
    return () => huddleRef.current?.setSuppressed(false);
  }, [ready, huddleActive]);

  useWakeLock(ready);

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    saveStageMuted(next);
    player.setMuted(next);
    pacerRef.current?.setMuted(next);
  }, [player]);

  const resumeAudio = useCallback(() => player.unlock(), [player]);

  return {
    state,
    current: state?.current ?? null,
    muted,
    toggleMuted,
    audioLocked: voice && audioLocked,
    resumeAudio,
    next: () => pacerRef.current?.next(),
    prev: () => pacerRef.current?.prev(),
    live: () => pacerRef.current?.live(),
    restart: () => pacerRef.current?.restart(),
  };
}

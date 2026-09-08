import { useCallback, useEffect, useRef, useState } from "react";
import {
  DUPLICATE_WINDOW,
  finalTranscriptsFromEvent,
  gateFinalTranscript,
  isBenignRecognitionError,
  latestInterimTranscript,
  nextVoiceStatus,
  recognitionErrorMessage,
  type VoiceModeStatus,
} from "./lib/voiceTranscript.ts";

/**
 * Huddle voice mode: the viewer's speech becomes channel messages.
 *
 * Continuous `SpeechRecognition` (the `webkit`-prefixed constructor in
 * Chrome/Brave/Edge; unprefixed where implemented) runs while the toggle is
 * on. Each FINAL result, gated by `lib/voiceTranscript.ts` (trimmed, >= 3
 * chars, deduped), is handed to `onFinalTranscript` — whose caller
 * publishes it through the channel's ordinary `send`, p-tagging the huddle's
 * agents so their mention-filtered subscriptions deliver it. Interim
 * results are surfaced as `interimText` for display and never published.
 *
 * Browser-API wiring is code-read covered (no component harness exists for
 * SpeechRecognition); the publish decisions live in the pure lib module and
 * are unit-tested there. This hook stays thin: construct, configure
 * (continuous, interimResults, lang en-US), restart on Chrome's
 * silence-triggered onend, clear state on fatal errors (no mic etc.), and
 * clean up on unmount/toggle-off/channel change.
 *
 * Reachability note: verified live on the target browser (Brave) that
 * `typeof webkitSpeechRecognition === "function"`. Where the API is absent
 * the hook reports `supported: false` and does nothing — the UI shows a
 * disabled toggle instead of a broken one.
 */

/**
 * The controller half of the Web Speech API. TypeScript's DOM lib ships the
 * event/result interfaces but not this one, so it is restated minimally and
 * structurally; the values assigned below (`continuous`, `interimResults`,
 * `lang`, `maxAlternatives`) are the documented set the wiring relies on.
 */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onaudiostart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const scope = window as unknown as Record<string, unknown>;
  const candidate =
    scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
  return typeof candidate === "function"
    ? (candidate as SpeechRecognitionCtor)
    : null;
}

/** Chrome stops continuous recognition after a silence window; the restart
 * delay keeps the start() → onend → start() loop off a hot path. */
const RESTART_DELAY_MS = 250;

export interface HuddleVoiceMode {
  /** Does this browser expose SpeechRecognition at all? */
  supported: boolean;
  /** The toggle. Turning it off stops recognition and clears interim text. */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  status: VoiceModeStatus;
  /** Latest interim recognition text, for display only. */
  interimText: string;
  /** Human message for the last fatal recognition error, if any. */
  error: string | null;
}

export function useHuddleVoiceMode(options: {
  /** The huddle channel; null (not connected) disables the hook entirely. */
  channelId: string | null;
  /**
   * Publish one gated final transcript. Called synchronously per final; the
   * caller owns the send path and error surfacing.
   */
  onFinalTranscript: (text: string) => void;
}): HuddleVoiceMode {
  const { channelId, onFinalTranscript } = options;
  const [supported] = useState(() => speechRecognitionCtor() !== null);
  const [enabled, setEnabledState] = useState(false);
  const [status, setStatus] = useState<VoiceModeStatus>("idle");
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live values the recognition callbacks read without re-subscribing.
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const transition = useCallback(
    (event: Parameters<typeof nextVoiceStatus>[1]) => {
      setStatus((current) => nextVoiceStatus(current, event));
    },
    [],
  );

  useEffect(() => {
    if (!channelId || !enabled) {
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      return;
    }

    // Chrome resets the results list on every start(), so the seen-index set
    // is per-session — but the duplicate window for finals SURVIVES
    // restarts, because a restart can replay the previous final.
    let seenIndices = new Set<number>();
    let recentFinals: string[] = [];
    let fatal = false;
    let restartTimer: number | null = null;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onaudiostart = () => {
      transition({ type: "audio_started" });
    };

    recognition.onresult = (event) => {
      for (const final of finalTranscriptsFromEvent(event, seenIndices)) {
        seenIndices.add(final.index);
        const gate = gateFinalTranscript(final.transcript, recentFinals);
        if (!gate.ok) {
          continue;
        }
        recentFinals.push(gate.text);
        if (recentFinals.length > DUPLICATE_WINDOW) {
          recentFinals = recentFinals.slice(-DUPLICATE_WINDOW);
        }
        onFinalRef.current(gate.text);
      }
      setInterimText(latestInterimTranscript(event));
    };

    recognition.onerror = (event) => {
      if (isBenignRecognitionError(event.error)) {
        return;
      }
      fatal = true;
      setError(recognitionErrorMessage(event.error));
      transition({ type: "errored", code: event.error });
      // A fatal error means the mic is unusable — clear the UI state so the
      // toggle stops claiming to listen, rather than auto-restarting into
      // the same wall. This flips `enabled`, which runs the cleanup below.
      setEnabledState(false);
    };

    recognition.onend = () => {
      transition({ type: "ended" });
      if (!enabledRef.current || fatal) {
        return;
      }
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        seenIndices = new Set<number>();
        transition({ type: "start" });
        try {
          recognition.start();
        } catch {
          // start() on an instance that is still winding down throws
          // InvalidStateError; the next onend (if any) re-arms the restart.
        }
      }, RESTART_DELAY_MS);
    };

    transition({ type: "start" });
    try {
      recognition.start();
    } catch {
      setError(recognitionErrorMessage("audio-capture"));
      transition({ type: "errored", code: "audio-capture" });
      setEnabledState(false);
    }

    return () => {
      if (restartTimer !== null) {
        window.clearTimeout(restartTimer);
        restartTimer = null;
      }
      // Drop handlers first so teardown cannot fire the restart path.
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onaudiostart = null;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
      setInterimText("");
    };
  }, [channelId, enabled, transition]);

  const setEnabled = useCallback((on: boolean) => {
    if (on) {
      setError(null);
    } else {
      setStatus((current) => nextVoiceStatus(current, { type: "stop" }));
    }
    setEnabledState(on);
  }, []);

  // Leaving the huddle (channelId → null) must latch voice mode off: the
  // toggle unmounts with the call controls, and a rejoin must not resume
  // listening on its own.
  useEffect(() => {
    if (channelId === null) {
      setEnabledState(false);
      setStatus("idle");
    }
  }, [channelId]);

  return { supported, enabled, setEnabled, status, interimText, error };
}

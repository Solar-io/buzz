/**
 * The agent-speech PLAYER — one utterance in, audio out, a settled result
 * back. Extracted verbatim (behaviour-wise) from the huddle's speaker
 * closure so Stage mode can reuse it; subscription, membership and roster
 * suppression stay with the huddle hook, which now consumes this.
 *
 * What it owns:
 *  - route selection at speak time (kind-30182 selection → optional
 *    channel override via `resolveHuddleVoice` → `speakRoute`);
 *  - sentence chunking (`chunkSpeakableText`);
 *  - the bridge leg (/tts POST per chunk with one-ahead prefetch,
 *    watchdog-raced, played through a gain node so the mute covers
 *    already-scheduled audio);
 *  - the local `speechSynthesis` fallback (per-chunk watchdog, settle on
 *    every path exactly once);
 *  - the stop token (`interrupt()` stops NOW, mid-chunk and mid-tail).
 *
 * Browser globals are read lazily so `node --test` can import it.
 */

import {
  chunkSpeakableText,
  resolveProfileVoice,
  speakRoute,
  type SpeakRoute,
  watchdogMs,
} from "../../huddle/lib/huddleAgentSpeech.ts";
import {
  playBridgeResponse,
  type BridgeAudioContextLike,
} from "../../huddle/lib/bridgeSpeech.ts";
import {
  resolveHuddleVoice,
  type HuddleVoiceOverride,
} from "../../huddle/lib/huddlePrefs.ts";
import { applySinkId } from "../../huddle/lib/huddleAudioGraph.ts";
import type { AgentVoiceSelection } from "./agentVoiceSelection.ts";

/**
 * How one `speak` ended:
 *  - "spoken": played on its intended route to the end;
 *  - "fallback": the bridge failed or was unavailable and local synth
 *    spoke it instead (dispositions `bridge-error-fallback` / `derived`);
 *  - "stopped": `interrupt()` / `dispose()` cut it short;
 *  - "failed": nothing could speak (no `speechSynthesis` in this browser —
 *    the pre-extraction guard, kept as-is).
 */
export type AgentSpeakResult = "spoken" | "fallback" | "stopped" | "failed";

export interface AgentSpeakOptions {
  /** Per-call override; falls back to the player's `getVoiceOverride`. */
  voiceOverride?: HuddleVoiceOverride | null;
}

export interface AgentSpeechPlayerDeps {
  /** The ranked local voice list, read at utterance time. */
  getVoices: () => SpeechSynthesisVoice[];
  /** Published kind-30182 selection by LOWERCASE pubkey. */
  voiceSelectionFor: (pubkey: string) => AgentVoiceSelection | undefined;
  /**
   * Owner kind-30183 assignment by LOWERCASE agent pubkey — outranks the
   * agent's own selection (voicePrecedence.ts). Optional: a caller without
   * it resolves as if no owner assigned anything.
   */
  voiceAssignmentFor?: (pubkey: string) => AgentVoiceSelection | undefined;
  /** Default voice override (the huddle's per-channel seam). */
  getVoiceOverride?: () => HuddleVoiceOverride | null;
  /** The /tts bridge URL, resolved per chunk. */
  ttsUrl: () => string;
  /** Called whenever a route is decided or corrected. */
  onRoute?: (pubkeyLower: string, route: SpeakRoute) => void;
  /** Called at synthesis start / end. */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Called when one chunk finished sounding (echo-suppression records). */
  onChunkSpoken?: (chunk: string) => void;
  /** Console prefix for the bridge-failure warning. */
  logTag?: string;
  /** Test seams: default to the browser globals. */
  createAudioContext?: () => BridgeAudioContextLike | null;
  fetchImpl?: typeof fetch;
}

export type AudioContextStateListener = (state: string) => void;

export interface AgentSpeechPlayer {
  speak(
    text: string,
    pubkey: string,
    opts?: AgentSpeakOptions,
  ): Promise<AgentSpeakResult>;
  /** Stop the current utterance NOW; a pending speak resolves "stopped". */
  interrupt(): void;
  /** Gain 0 for the bridge leg, volume 0 for later local utterances. */
  setMuted(muted: boolean): void;
  /** Route agent audio at a chosen speaker; remembered for a later context. */
  setOutputDevice(deviceId: string): void;
  /**
   * Call INSIDE a user gesture: create/resume the AudioContext, play a
   * 1-sample silent buffer, and prime `speechSynthesis` with an empty
   * utterance, so later un-gestured speech is allowed to sound.
   */
  unlock(): void;
  /**
   * Interrupt and release the AudioContext (the output device). The player
   * stays usable — the next speak lazily creates a fresh context.
   */
  dispose(): void;
  /** Current AudioContext state, or null before one exists. */
  contextState(): string | null;
  /** Subscribe to AudioContext `statechange` (suspended/interrupted/...). */
  onContextStateChange(listener: AudioContextStateListener): () => void;
}

function speechSynthesisSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined"
  );
}

/** The default context: 24 kHz preferred, browser default as fallback. */
function defaultAudioContext(): BridgeAudioContextLike | null {
  if (
    typeof window === "undefined" ||
    typeof window.AudioContext === "undefined"
  ) {
    return null;
  }
  let created: AudioContext;
  try {
    created = new window.AudioContext({ sampleRate: 24_000 });
  } catch {
    created = new window.AudioContext();
  }
  return created as unknown as BridgeAudioContextLike;
}

/** The context surface beyond what the bridge scheduler needs. */
type PlayerContext = BridgeAudioContextLike & {
  state?: string;
  sampleRate?: number;
  resume?: () => Promise<void>;
  createGain?: () => GainNode;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
};

/** Poll interval for the currentTime tail gate. */
const TAIL_POLL_MS = 20;

export function createAgentSpeechPlayer(
  deps: AgentSpeechPlayerDeps,
): AgentSpeechPlayer {
  const logTag = deps.logTag ?? "[agent-speech]";
  const createContext = deps.createAudioContext ?? defaultAudioContext;
  let muted = false;
  let outputDeviceId = "";
  let ctx: PlayerContext | null = null;
  let gain: GainNode | null = null;
  const stateListeners = new Set<AudioContextStateListener>();
  const onStateChange = () => {
    const state = ctx?.state ?? "closed";
    for (const listener of stateListeners) {
      listener(state);
    }
  };

  /**
   * Mid-reply stop. Bumped by every interrupt/dispose; a running reply's
   * chunk loop checks it before each sentence, and the in-flight chunk's
   * settle is invoked immediately through `activeSettle` — so "stop
   * reading" stops NOW, not when the watchdog gives up on an engine that
   * fires neither onend nor onerror after `cancel()`.
   */
  let stopToken = 0;
  let activeSettle: (() => void) | null = null;
  /** Wakes a bridge fetch await on interrupt (see `speak`). */
  const stopWaiters = new Set<() => void>();

  const bridgeContext = (): PlayerContext | null => {
    if (ctx === null) {
      const created = createContext() as PlayerContext | null;
      if (created === null) {
        return null;
      }
      ctx = created;
      // One gain for agent audio, mirroring the room's: muting has to
      // silence what is already scheduled, not only what arrives next.
      try {
        const g = created.createGain?.();
        if (!g) throw new Error("no createGain");
        g.gain.value = muted ? 0 : 1;
        g.connect(created.destination);
        gain = g;
      } catch {
        gain = null;
      }
      if (outputDeviceId !== "") {
        void applySinkId(created, outputDeviceId);
      }
      created.addEventListener?.("statechange", onStateChange);
    }
    void ctx.resume?.();
    return ctx;
  };

  /**
   * Settle when the context CLOCK has passed the scheduled tail, not merely
   * when a wall-clock timer says it should have: a suspended context holds
   * its clock still, and "spoken" must mean it sounded. The wall-clock
   * backstop (twice the expected tail + 1 s) keeps a frozen clock from
   * wedging the queue forever.
   */
  const settleOnClock =
    (context: PlayerContext) =>
    (delayMs: number, fn: () => void): (() => void) => {
      const tail = context.currentTime + Math.max(0, delayMs - 30) / 1000;
      const poll = setInterval(() => {
        if (context.currentTime >= tail) {
          done();
        }
      }, TAIL_POLL_MS);
      const backstop = setTimeout(() => done(), delayMs * 2 + 1_000);
      let fired = false;
      function done() {
        if (fired) return;
        fired = true;
        clearInterval(poll);
        clearTimeout(backstop);
        fn();
      }
      return () => {
        fired = true;
        clearInterval(poll);
        clearTimeout(backstop);
      };
    };

  const interrupt = () => {
    stopToken += 1;
    activeSettle?.();
    activeSettle = null;
    for (const wake of stopWaiters) {
      wake();
    }
    stopWaiters.clear();
    if (speechSynthesisSupported()) {
      window.speechSynthesis.cancel();
    }
  };

  const speak = async (
    text: string,
    speakerPubkey: string,
    opts: AgentSpeakOptions = {},
  ): Promise<AgentSpeakResult> => {
    if (!speechSynthesisSupported()) {
      return "failed";
    }
    const stopAt = stopToken;
    const stopped = () => stopToken !== stopAt;
    const key = speakerPubkey.toLowerCase();
    // THE SEAM (voicePrecedence.ts): channel override, then the owner's
    // 30183 assignment, then the agent's own 30182, then nothing — and a
    // stale `local-synth` row counts as nothing.
    const published = deps.voiceSelectionFor(key);
    const override =
      opts.voiceOverride !== undefined
        ? opts.voiceOverride
        : (deps.getVoiceOverride?.() ?? null);
    const assignment = deps.voiceAssignmentFor?.(key);
    const selected = resolveHuddleVoice(override, published, assignment);
    const voices = deps.getVoices();
    const route = speakRoute(speakerPubkey, voices, selected);
    deps.onRoute?.(key, route);
    const profile = route.profile;
    const voice = resolveProfileVoice(profile, voices);
    // Sentence-sized chunks: Chromium stalls single utterances past
    // ~15 s, so a long reply must never be ONE utterance. Chunks also
    // bound the watchdog and make cancellation land between sentences.
    const chunks = chunkSpeakableText(text);
    const utterances = chunks.length > 0 ? chunks : [text];
    deps.onSpeakingChange?.(true);
    let outcome: AgentSpeakResult = "spoken";

    // Bridge engines: `route.bridge` IS the decision — execute it, or fall
    // to the local-synth path below. A bridge failure must not mute the
    // reply; a browser with no AudioContext corrects `derived-bridge` to
    // `derived`.
    const bridgeRequest = route.bridge;
    if (bridgeRequest !== null) {
      const context = bridgeContext();
      if (context !== null) {
        let bridgeFailed = false;
        const doFetch = deps.fetchImpl ?? fetch;
        /**
         * One bridge POST, abortable. PREFETCH-ONE-AHEAD (design §6.2):
         * chunk N+1 is requested as soon as chunk N's response HEADERS
         * arrive, not after chunk N finished playing — Chatterbox's first
         * byte is ~0.4 s, and fetching sequentially turned that into an
         * audible gap between every pair of chunks. At most one prefetched
         * request is held; an interrupt or failure aborts it.
         */
        const startFetch = (chunk: string) => {
          const controller =
            typeof AbortController === "undefined"
              ? null
              : new AbortController();
          const promise = doFetch(deps.ttsUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              engine: bridgeRequest.engine,
              voice: bridgeRequest.voice,
              text: chunk,
            }),
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          // An aborted or failed prefetch that nobody awaits must not
          // surface as an unhandled rejection.
          promise.catch(() => {});
          return {
            chunk,
            promise,
            cancel: () => {
              controller?.abort();
              void promise.then((r) => r.body?.cancel()).catch(() => {});
            },
          };
        };
        type InFlight = ReturnType<typeof startFetch>;
        let current: InFlight | null = null;
        let prefetched: InFlight | null = null;
        try {
          for (let i = 0; i < utterances.length; i++) {
            if (stopped()) {
              break;
            }
            const chunk = utterances[i];
            current = prefetched ?? startFetch(chunk);
            prefetched = null;
            // A hung bridge must not wedge the queue (watchdog), and an
            // interrupt must not wait for the fetch to answer (stop race).
            let wake: () => void = () => {};
            let watchdog: ReturnType<typeof setTimeout> | null = null;
            const raced = await Promise.race([
              current.promise,
              new Promise<never>((_, reject) => {
                watchdog = setTimeout(
                  () => reject(new Error("bridge fetch watchdog")),
                  watchdogMs(chunk),
                );
              }),
              new Promise<null>((resolve) => {
                wake = () => resolve(null);
                stopWaiters.add(wake);
              }),
            ]).finally(() => {
              stopWaiters.delete(wake);
              if (watchdog !== null) clearTimeout(watchdog);
            });
            if (raced === null) {
              // Interrupted mid-fetch: drop the body when it lands.
              current.cancel();
              current = null;
              break;
            }
            if (!raced.ok) {
              throw new Error(`bridge ${raced.status}`);
            }
            // Headers are in: request the next chunk NOW so it is
            // synthesizing while this one plays.
            if (i + 1 < utterances.length && !stopped()) {
              prefetched = startFetch(utterances[i + 1]);
            }
            const servedEngine = raced.headers?.get?.("x-tts-engine") ?? null;
            if (servedEngine) {
              const servedVoice = raced.headers?.get?.("x-tts-voice") ?? null;
              deps.onRoute?.(key, {
                ...route,
                servedEngine,
                ...(servedVoice ? { servedVoice } : {}),
              });
            }
            current = null;
            await playBridgeResponse(raced, context, {
              shouldStop: stopped,
              scheduleSettle: settleOnClock(context),
              ...(gain === null ? {} : { destination: gain }),
            });
            deps.onChunkSpoken?.(chunk);
          }
          prefetched?.cancel();
          prefetched = null;
        } catch (err) {
          current?.cancel();
          prefetched?.cancel();
          bridgeFailed = true;
          console.warn(`${logTag} bridge failed, speaking locally`, err);
        }
        if (!bridgeFailed) {
          deps.onSpeakingChange?.(false);
          return stopped() ? "stopped" : "spoken";
        }
        outcome = "fallback";
        deps.onRoute?.(key, {
          disposition: "bridge-error-fallback",
          profile,
          bridge: null,
        });
      } else if (route.disposition === "derived-bridge") {
        outcome = "fallback";
        deps.onRoute?.(key, { disposition: "derived", profile, bridge: null });
      }
    }

    try {
      for (const chunk of utterances) {
        if (stopped()) {
          break;
        }
        // One chunk = one utterance, settling on EVERY path exactly once:
        // onend, onerror, its own watchdog, or a forced stop.
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(chunk);
          if (voice) {
            utterance.voice = voice;
          } else {
            // Voiceless path: tag the text English so the default engine
            // does not read it through another locale.
            utterance.lang = "en";
          }
          utterance.rate = profile.rate;
          utterance.pitch = profile.pitch;
          // No gain node on this path: the mute lands on the utterance.
          utterance.volume = muted ? 0 : 1;
          let settled = false;
          let watchdog: ReturnType<typeof setTimeout> | null = null;
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            if (watchdog !== null) {
              clearTimeout(watchdog);
              watchdog = null;
            }
            if (activeSettle === finish) {
              activeSettle = null;
            }
            resolve();
          };
          watchdog = setTimeout(finish, watchdogMs(chunk));
          utterance.onend = finish;
          utterance.onerror = finish;
          activeSettle = finish;
          window.speechSynthesis.speak(utterance);
        });
        // Chunk-level echo records, even for a chunk cut short: part of
        // it sounded (pre-extraction behaviour).
        deps.onChunkSpoken?.(chunk);
      }
    } finally {
      deps.onSpeakingChange?.(false);
    }
    return stopped() ? "stopped" : outcome;
  };

  return {
    speak,
    interrupt,
    setMuted(next) {
      muted = next;
      if (gain) {
        gain.gain.value = next ? 0 : 1;
      }
    },
    setOutputDevice(deviceId) {
      outputDeviceId = deviceId;
      if (ctx !== null) {
        void applySinkId(ctx, deviceId);
      }
    },
    unlock() {
      const context = bridgeContext();
      if (context !== null) {
        try {
          const buffer = context.createBuffer(
            1,
            1,
            context.sampleRate ?? 24_000,
          );
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.start(0);
        } catch {
          // Priming is best-effort.
        }
      }
      if (speechSynthesisSupported()) {
        try {
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
        } catch {
          // Priming is best-effort.
        }
      }
    },
    dispose() {
      interrupt();
      const closing = ctx;
      ctx = null;
      gain = null;
      closing?.removeEventListener?.("statechange", onStateChange);
      void closing?.close?.().catch(() => {});
    },
    contextState() {
      return ctx === null ? null : (ctx.state ?? null);
    },
    onContextStateChange(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}

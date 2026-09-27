/**
 * The Stage pacer — a pure state machine that decides WHEN each showing is
 * released onto the stage (design §5, amended by §15.2).
 *
 * Nothing here touches the DOM, audio or timers directly: the clock, the
 * speaker, the interrupt and the image-readiness probe are injected, so the
 * whole release rule is testable with a fake clock.
 *
 * Release rule for a HELD showing k (k-1 = the one currently on stage):
 *
 *   released(k) = max( arrived(k),
 *                      done(k-1) + gap,
 *                      imageReady(k) or + imageCapMs )
 *
 * where done(k-1) depends on the mode:
 *   - manifest voice:false → shown(k-1), and NO gap (the agent's cadence
 *     governs; P2 wants a part on screen within 250 ms of arrival);
 *   - voice on, audible    → speak(k-1) settles, capped at watchdogMs(text);
 *   - voice on, muted / audio unavailable → shown(k-1) + readingTimeMs(text),
 *     and speak is NEVER called (P3).
 *
 * A `hold:false` showing skips the rule entirely: it is shown the moment it
 * arrives, interrupts any in-progress speech, speaks its own text, and
 * silently releases every EARLIER queued held showing (visible in chat,
 * never staged, never spoken) so chat never shows posts out of order.
 *
 * Ordering: `seed` (history / replay) sorts by the post-order key
 * (`compareShowings`: created_at, seq, id). A LIVE `arrive` never lands
 * inside the released prefix — whatever its key says, it arrived after what
 * is already on stage, so it queues (or, unheld, stages) after it. Live
 * arrival order beats the key for anything not yet staged, so a live
 * showing is never silently released.
 *
 * Speak-once is keyed by the showing's eventId (frames repeat, so `i` is
 * not a key). Unmuting never re-speaks the current showing.
 */

import { watchdogMs as defaultWatchdogMs } from "../../huddle/lib/huddleAgentSpeech.ts";
import { compareShowings } from "./stageSession.ts";

/** Silence between one showing finishing and the next being released. */
export const STAGE_GAP_MS = 600;
/** Longest a held release waits for its image to decode. */
export const STAGE_IMAGE_CAP_MS = 3_000;

export const READING_MS_PER_CHAR = 60;
export const READING_MIN_MS = 3_000;
export const READING_MAX_MS = 30_000;

/** Muted pacing: ≈60 ms/char, clamped to [3 s, 30 s]. */
export function readingTimeMs(text: string): number {
  return Math.min(
    READING_MAX_MS,
    Math.max(READING_MIN_MS, text.length * READING_MS_PER_CHAR),
  );
}

export interface PacerShowing {
  eventId: string;
  hold: boolean;
  speakText: string;
  createdAt: number;
  /** Optional CLI posting counter — see `compareShowings`. */
  seq?: number;
}

export interface PacerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PacerState<T extends PacerShowing> {
  /** Every showing the pacer knows, in post order. */
  showings: readonly T[];
  /** Ids visible in chat (released, staged or silently). */
  releasedIds: ReadonlySet<string>;
  /** Index into `showings` of what is on stage; -1 before the first. */
  currentIndex: number;
  current: T | null;
  /** How many showings are released (they are always a prefix). */
  releasedCount: number;
  /** Held showings waiting for their gate. */
  queued: number;
  /** Sam stepped back with Prev; releases pause until Live/Next. */
  browsing: boolean;
  /** eventId currently being spoken, or null. */
  speakingId: string | null;
}

export interface StagePacerDeps<T extends PacerShowing> {
  clock: PacerClock;
  /** Speak one showing; settle (either way) when the audio is done. */
  speak: (showing: T) => Promise<unknown>;
  /** Stop the current utterance now. */
  interrupt: () => void;
  /** Manifest `voice`. false = no speech gate at all. */
  voice: boolean;
  muted?: boolean;
  audioAvailable?: boolean;
  gapMs?: number;
  imageCapMs?: number;
  readingTimeMs?: (text: string) => number;
  watchdogMs?: (text: string) => number;
  /** Resolves when the showing's image is decoded. Absent = always ready. */
  imageReady?: (showing: T) => Promise<unknown>;
  onChange?: (state: PacerState<T>) => void;
}

export interface StagePacer<T extends PacerShowing> {
  /** A showing arrived live. Duplicate eventIds are ignored. */
  arrive(showing: T): void;
  /**
   * Load history in one go. `replay` walks from the first showing (all
   * treated as held, so each is spoken in order); `late` joins a live
   * session at the newest showing without speaking the backlog.
   */
  seed(showings: readonly T[], mode: "replay" | "late"): void;
  setMuted(muted: boolean): void;
  setAudioAvailable(available: boolean): void;
  /** Step forward (browsing) or release the next queued showing now. */
  next(): void;
  /** Browse back one showing, without speaking. */
  prev(): void;
  /** Jump to the newest released showing and resume releases. */
  live(): void;
  /** Replay from the first showing ("From the start"). */
  restart(): void;
  state(): PacerState<T>;
  dispose(): void;
}

type Phase = "idle" | "holding" | "gap" | "image";

export function createStagePacer<T extends PacerShowing>(
  deps: StagePacerDeps<T>,
): StagePacer<T> {
  const { clock } = deps;
  const gapMs = deps.gapMs ?? STAGE_GAP_MS;
  const imageCapMs = deps.imageCapMs ?? STAGE_IMAGE_CAP_MS;
  const readMs = deps.readingTimeMs ?? readingTimeMs;
  const dogMs = deps.watchdogMs ?? defaultWatchdogMs;

  let list: T[] = [];
  const known = new Set<string>();
  let released = 0;
  let current = -1;
  let browsing = false;
  let muted = deps.muted ?? false;
  let audioAvailable = deps.audioAvailable ?? true;
  let phase: Phase = "idle";
  /** Bumped on every gate change; stale callbacks compare and bail. */
  let gen = 0;
  let timers: unknown[] = [];
  let speakingId: string | null = null;
  /** When the current gate started and how long its reading timer is. */
  let gateStartedAt = 0;
  let imageOkFor: string | null = null;
  const spoken = new Set<string>();
  let disposed = false;

  const silent = () => muted || !audioAvailable;

  function clearTimers() {
    for (const handle of timers) clock.clearTimeout(handle);
    timers = [];
  }

  function later(fn: () => void, ms: number) {
    timers.push(clock.setTimeout(fn, Math.max(0, ms)));
  }

  function snapshot(): PacerState<T> {
    const releasedIds = new Set<string>();
    for (let index = 0; index < released; index += 1) {
      releasedIds.add(list[index].eventId);
    }
    return {
      showings: list.slice(),
      releasedIds,
      currentIndex: current,
      current: current >= 0 ? (list[current] ?? null) : null,
      releasedCount: released,
      queued: list.length - released,
      browsing,
      speakingId,
    };
  }

  function notify() {
    if (!disposed) deps.onChange?.(snapshot());
  }

  /** Stop whatever speech is in flight (the gate itself is the caller's). */
  function stopSpeech() {
    if (speakingId !== null) {
      speakingId = null;
      deps.interrupt();
    }
  }

  /** The gate for the showing on stage is done: gap, then pump. */
  function finish(token: number, withGap: boolean) {
    if (token !== gen || disposed) return;
    clearTimers();
    speakingId = null;
    if (!withGap || gapMs <= 0) {
      phase = "idle";
      notify();
      pump();
      return;
    }
    phase = "gap";
    notify();
    later(() => {
      if (token !== gen) return;
      phase = "idle";
      pump();
    }, gapMs);
  }

  function readingGate(token: number, text: string, elapsed: number) {
    speakingId = null;
    later(() => finish(token, true), readMs(text) - elapsed);
  }

  /** Put `list[index]` on stage and start its done-gate. */
  function stage(index: number) {
    gen += 1;
    const token = gen;
    clearTimers();
    current = index;
    browsing = false;
    phase = "holding";
    gateStartedAt = clock.now();
    const showing = list[index];
    if (!deps.voice) {
      // voice:false — done at shown; the agent's cadence governs.
      notify();
      finish(token, false);
      return;
    }
    const text = showing.speakText;
    if (silent() || !text.trim() || spoken.has(showing.eventId)) {
      readingGate(token, text, 0);
      notify();
      return;
    }
    spoken.add(showing.eventId);
    speakingId = showing.eventId;
    later(() => {
      if (token !== gen) return;
      // Watchdog: a hung bridge never wedges the queue (P4).
      stopSpeech();
      finish(token, true);
    }, dogMs(text));
    notify();
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(deps.speak(showing));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      () => finish(token, true),
      () => finish(token, true),
    );
  }

  function releaseNextHeld() {
    const index = released;
    released += 1;
    imageOkFor = null;
    stage(index);
  }

  /** Release the next held showing when its gate allows. */
  function pump() {
    if (disposed || browsing || phase !== "idle") return;
    if (released >= list.length) return;
    const next = list[released];
    if (deps.imageReady && imageOkFor !== next.eventId) {
      phase = "image";
      gen += 1;
      const token = gen;
      let settled = false;
      const go = () => {
        if (settled || token !== gen) return;
        settled = true;
        clearTimers();
        imageOkFor = next.eventId;
        phase = "idle";
        pump();
      };
      later(go, imageCapMs);
      deps
        .imageReady(next)
        .then(go, go)
        .catch(() => {});
      return;
    }
    releaseNextHeld();
  }

  /**
   * Sorted insert by the post-order key, never before `floor`. Seed passes 0
   * (pure key order); a live arrival passes the released count, so it can
   * only ever join the unreleased queue.
   */
  function insert(showing: T, floor = 0): number {
    let position = list.length;
    while (
      position > floor &&
      compareShowings(list[position - 1], showing) > 0
    ) {
      position -= 1;
    }
    list.splice(position, 0, showing);
    known.add(showing.eventId);
    if (position < released) {
      released += 1;
      if (current >= position) current += 1;
    }
    return position;
  }

  function arriveUnheld(position: number) {
    // Earlier queued held showings: released silently, never staged/spoken.
    if (position >= released) released = position + 1;
    stopSpeech();
    imageOkFor = null;
    stage(position);
  }

  function seed(showings: readonly T[], mode: "replay" | "late") {
    if (disposed) return;
    gen += 1;
    clearTimers();
    stopSpeech();
    list = [];
    known.clear();
    released = 0;
    current = -1;
    browsing = false;
    phase = "idle";
    imageOkFor = null;
    for (const showing of showings) {
      if (!known.has(showing.eventId)) insert(showing);
    }
    if (mode === "late" && list.length > 0) {
      released = list.length;
      current = list.length - 1;
      notify();
      return;
    }
    notify();
    pump();
  }

  return {
    arrive(showing) {
      if (disposed || known.has(showing.eventId)) return;
      // Live: never inside the released prefix (see the header).
      const position = insert(showing, released);
      if (!showing.hold) {
        arriveUnheld(position);
        return;
      }
      notify();
      pump();
    },

    seed,

    setMuted(next) {
      if (disposed || next === muted) return;
      const wasSilent = silent();
      muted = next;
      goSilentIfNeeded(wasSilent);
      notify();
    },

    setAudioAvailable(next) {
      if (disposed || next === audioAvailable) return;
      const wasSilent = silent();
      audioAvailable = next;
      goSilentIfNeeded(wasSilent);
      notify();
    },

    next() {
      if (disposed) return;
      if (browsing || current < released - 1) {
        current = Math.min(released - 1, current + 1);
        if (current === released - 1) {
          browsing = false;
          pump();
        }
        notify();
        return;
      }
      if (released < list.length) {
        stopSpeech();
        releaseNextHeld();
        return;
      }
      if (speakingId !== null) {
        stopSpeech();
        finish(gen, false);
      }
    },

    prev() {
      if (disposed || current <= 0) return;
      current -= 1;
      browsing = true;
      notify();
    },

    live() {
      if (disposed) return;
      current = released - 1;
      browsing = false;
      notify();
      pump();
    },

    restart() {
      if (disposed) return;
      spoken.clear();
      seed(list.slice(), "replay");
    },

    state: snapshot,

    dispose() {
      disposed = true;
      gen += 1;
      clearTimers();
      stopSpeech();
    },
  };

  /**
   * Muting / losing audio mid-part: stop speech now and finish the part on
   * the reading timer's REMAINDER. Unmuting changes nothing for the current
   * part (never re-spoken) — the next showing speaks.
   */
  function goSilentIfNeeded(wasSilent: boolean) {
    if (wasSilent || !silent()) return;
    if (phase !== "holding" || speakingId === null || current < 0) return;
    const showing = list[current];
    stopSpeech();
    gen += 1;
    const token = gen;
    clearTimers();
    readingGate(token, showing.speakText, clock.now() - gateStartedAt);
  }
}

/**
 * Barge-in auto-duck gate — the pure state machine behind the video-chat
 * auto-duck feature.
 *
 * On open speakers the persona's own TTS is picked up by the user's mic and
 * re-enters Anam's ASR as input, so she interrupts herself (barge-in
 * feedback loop; browser AEC leaks in WKWebView). While she is audibly
 * speaking, the mic input must be muted at the SDK layer; when she stops,
 * it restores. This module decides *when*; `useBargeDuck` applies it.
 *
 * Pure logic: every decision is a function of (state, rms, nowMs, config).
 * Timestamps are injected by the caller — nothing here reads the clock —
 * so tests drive it with literal sample times and assert literal outcomes.
 */

/** Level + timing thresholds. RMS is 0..1 over one analyser frame. */
export interface DuckGateConfig {
  /** RMS at or above which speech is considered audible (starts attack). */
  onThreshold: number;
  /** RMS below which the persona is considered done talking (starts hold). */
  offThreshold: number;
  /** ms the level must stay >= onThreshold before the gate closes. */
  attackMs: number;
  /** ms the gate stays closed after the level drops below offThreshold —
   * covers the TTS echo tail so the gate does not reopen mid-decay. */
  holdMs: number;
}

export const DEFAULT_DUCK_GATE_CONFIG: DuckGateConfig = {
  attackMs: 300,
  holdMs: 1500,
  offThreshold: 0.012,
  onThreshold: 0.02,
};

/** `listening` = mic open, `ducked` = mic input muted. */
export type DuckGatePhase = "listening" | "ducked";

export interface DuckGateState {
  readonly phase: DuckGatePhase;
  /** Timestamp of the first sample of the current above-threshold run
   * (listening only); null when the level is below onThreshold. */
  readonly attackStartedAt: number | null;
  /** Timestamp of the last sample >= offThreshold while ducked. */
  readonly lastLoudAt: number | null;
}

export interface DuckGateStep {
  readonly state: DuckGateState;
  /** Desired SDK mute state: true = muteInputAudio, false = unmute. */
  readonly ducked: boolean;
  /** Whether `ducked` flipped on this call (drive client calls from this). */
  readonly changed: boolean;
}

/** Fresh gate: listening, mic open, nothing timed. */
export function createDuckGate(): DuckGateState {
  return { attackStartedAt: null, lastLoudAt: null, phase: "listening" };
}

/**
 * Advance the gate by one audio sample.
 *
 * - Hysteresis: closes via onThreshold, reopens only below offThreshold, so
 *   a level wandering in the band does not chatter.
 * - Attack: a run must persist >= attackMs above onThreshold before the
 *   gate closes; a shorter blip resets it (a knock is not speech).
 * - Hold: after the level falls below offThreshold the gate stays closed
 *   holdMs longer, covering reverb/echo decay.
 */
export function stepDuckGate(
  state: DuckGateState,
  rms: number,
  nowMs: number,
  config: DuckGateConfig,
): DuckGateStep {
  if (state.phase === "listening") {
    if (rms < config.onThreshold) {
      // Below the close threshold: any half-formed attack is abandoned.
      if (state.attackStartedAt === null) {
        return { changed: false, ducked: false, state };
      }
      return {
        changed: false,
        ducked: false,
        state: { ...state, attackStartedAt: null },
      };
    }
    const startedAt = state.attackStartedAt ?? nowMs;
    if (nowMs - startedAt < config.attackMs) {
      return {
        changed: false,
        ducked: false,
        state: { ...state, attackStartedAt: startedAt },
      };
    }
    return {
      changed: true,
      ducked: true,
      state: {
        attackStartedAt: null,
        lastLoudAt: nowMs,
        phase: "ducked",
      },
    };
  }

  // ducked: reopen only once quiet has held for holdMs past the last
  // sample at or above offThreshold.
  const lastLoudAt =
    rms >= config.offThreshold ? nowMs : (state.lastLoudAt ?? nowMs);
  if (nowMs - lastLoudAt < config.holdMs) {
    return {
      changed: false,
      ducked: true,
      // Any audible/band sample pushes the hold deadline out — it must
      // land in the returned state or the tail silently never extends.
      state: lastLoudAt === state.lastLoudAt ? state : { ...state, lastLoudAt },
    };
  }
  return {
    changed: true,
    ducked: false,
    state: {
      attackStartedAt: null,
      lastLoudAt: null,
      phase: "listening",
    },
  };
}

/** Root-mean-square of one time-domain frame (each sample -1..1). */
export function computeRms(samples: ArrayLike<number>): number {
  const length = samples.length;
  if (length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / length);
}

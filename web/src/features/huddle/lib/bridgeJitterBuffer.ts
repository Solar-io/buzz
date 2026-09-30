/**
 * Adaptive jitter-buffer POLICY for the TTS bridge stream scheduler
 * (`bridgeSpeech.ts` → `playBridgeResponse`). Pure: no clock, no audio —
 * the scheduler feeds it numbers and asks "may I start scheduling now?".
 *
 * Why it exists (2026-09-29): with the GPU contended, Chatterbox generated
 * SLOWER than real time (RTF 1.3–1.9 — 6.2 s of audio took 7.9 s to
 * stream). The scheduler played every piece the moment it arrived, so the
 * tail kept running dry: ~0.5 s of speech, silence, 0.5 s, silence. The
 * fix is to trade a little up-front delay for continuous speech:
 *
 *  1. INITIAL prebuffer — hold a stream's first audio until
 *     {@link INITIAL_PREBUFFER_SECONDS} is buffered (or the stream ends).
 *     Small on purpose: on the healthy path (RTF well under 1) that much
 *     audio lands within ~0.1–0.2 s of the first byte, and a bridge that
 *     streams whole-sentence chunks meets it with the first read, so the
 *     fast path keeps its latency. It also absorbs ordinary chunk jitter.
 *
 *  2. REBUFFER on underrun — if the scheduled tail has already sounded when
 *     more audio arrives, the stream is slower than real time. Stop
 *     scheduling, and resume only once enough is buffered that the REST of
 *     the utterance can play through at the observed arrival rate:
 *
 *        buffer ≥ remaining × (1 − rate) × SAFETY
 *
 *     (while B seconds play, rate·B more arrive; solving B + rate·T = T for
 *     T = remaining gives the bound). Each further underrun also doubles a
 *     floor, so a mis-estimate converges instead of stuttering forever.
 *
 *  3. Stream end ALWAYS flushes — the buffer never withholds audio once the
 *     server is done, so the worst case is "play after full download".
 *
 * Remaining length is unknown to a PCM stream, so the caller passes an
 * estimate from the chunk's text ({@link estimateSpeechSeconds}) and a
 * cross-stream {@link BridgeRateHistory}: a contended GPU stays contended
 * for the next sentence, so the next chunk starts with a buffer sized for
 * the rate already seen instead of discovering it through a gap.
 */

/** First-start prebuffer (seconds of audio). See module doc, rule 1. */
export const INITIAL_PREBUFFER_SECONDS = 0.4;

/** Floor for the first rebuffer; doubles with each further underrun. */
export const REBUFFER_FLOOR_SECONDS = 1.0;

/** Headroom on the rate-derived target (arrival rate is noisy). */
export const REBUFFER_SAFETY = 1.25;

/**
 * Minimum wall time over which an arrival rate is trusted. Below this a
 * burst of backlog (e.g. a prefetched body) would read as "infinitely
 * fast" or a single late chunk as "stalled".
 */
export const MIN_RATE_WINDOW_SECONDS = 0.25;

/**
 * Deliberately SLOW speaking-rate assumption for the length estimate
 * (English TTS is typically ~14–16 chars/s). Over-estimating only costs a
 * little extra buffering on a slow stream, and stream end caps it;
 * under-estimating costs a gap.
 */
export const ESTIMATE_CHARS_PER_SECOND = 12;

/** Cross-stream memory of the last observed arrival rate. */
export interface BridgeRateHistory {
  /** Audio seconds delivered per wall second, or null if never measured. */
  rate: number | null;
}

export function createRateHistory(): BridgeRateHistory {
  return { rate: null };
}

/** Rough audio length a text chunk will synthesize to. */
export function estimateSpeechSeconds(text: string): number {
  return text.trim().length / ESTIMATE_CHARS_PER_SECOND;
}

export interface JitterState {
  /** Audio received but not yet handed to the clock. */
  bufferedSeconds: number;
  /** All audio received this stream (scheduled + buffered). */
  receivedSeconds: number;
  /** Audio already handed to the clock. */
  scheduledSeconds: number;
  /**
   * Audio received AFTER the first read. The rate numerator: the first
   * read lands at elapsed 0 (and may be a prefetched backlog), so counting
   * it would overstate the rate early in the stream — exactly when the
   * start decision is made.
   */
  arrivedAfterFirstSeconds: number;
  /** Wall seconds since this stream's first read. */
  elapsedSeconds: number;
  /** Underruns observed so far this stream (0 = still on initial start). */
  underruns: number;
  /** Estimated total audio for this stream, if the caller knows the text. */
  expectedSeconds?: number | null;
  /** Rate seen on the previous stream, used until this one is measurable. */
  historyRate?: number | null;
  /** The server has closed the body. */
  streamDone: boolean;
}

/** Arrival rate (audio s per wall s) once measurable, else null. */
export function observedRate(state: JitterState): number | null {
  if (state.elapsedSeconds < MIN_RATE_WINDOW_SECONDS) return null;
  return state.arrivedAfterFirstSeconds / state.elapsedSeconds;
}

/**
 * How many seconds must be buffered before (re)starting playback.
 * Returns 0 when the stream is done (flush everything).
 */
export function prebufferTarget(state: JitterState): number {
  if (state.streamDone) return 0;
  const floor =
    state.underruns === 0
      ? INITIAL_PREBUFFER_SECONDS
      : REBUFFER_FLOOR_SECONDS * 2 ** (state.underruns - 1);
  const rate = observedRate(state) ?? state.historyRate ?? null;
  if (rate === null || rate >= 1) return floor;
  // Audio still to be played from the moment we resume. With a text
  // estimate: what's left of it. Without one (or once the estimate is
  // exhausted after an underrun): assume at least as much again as has
  // arrived — sentence chunks are similar in length.
  const expected = state.expectedSeconds ?? null;
  let remaining =
    expected !== null ? expected - state.scheduledSeconds : Number.NaN;
  if (!(remaining > 0) && state.underruns > 0) {
    remaining = state.receivedSeconds;
  }
  if (!(remaining > 0)) return floor;
  return Math.max(floor, remaining * (1 - rate) * REBUFFER_SAFETY);
}

/** May the scheduler hand the buffered audio to the clock now? */
export function shouldStartPlayback(state: JitterState): boolean {
  if (state.bufferedSeconds <= 0) return false;
  return state.streamDone || state.bufferedSeconds >= prebufferTarget(state);
}

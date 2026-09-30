/**
 * Adaptive jitter-buffer POLICY for the TTS bridge stream scheduler
 * (`bridgeSpeech.ts` → `playBridgeResponse`). Pure: no clock, no audio, no
 * I/O apart from the explicit {@link loadCalibration}/{@link saveCalibration}
 * pair. The scheduler asks one question — "at what clock time may the
 * buffered audio start?" — via {@link startAt}.
 *
 * Why (2026-09-29): with the GPU contended, Chatterbox generated slower
 * than real time AND decelerated within a sentence (KV-cache growth), so
 * on-arrival scheduling stuttered, and simple rate-threshold buffers either
 * started far too late (a 15 chars/s length prior) or still gapped on the
 * slowest voice. This is the architect's "profile model" (prototype +
 * 22 live traces, `__fixtures__/bridge-traces/`):
 *
 *  - Generation profile: producing audio position x (seconds) costs wall
 *    time proportional to G(x) = (x − x1) + KAPPA/2 · (x² − x1²) after the
 *    first arrival (x1 = first read's audio) — i.e. per-second cost grows
 *    linearly, g(x) = c · (1 + KAPPA·x). One per-stream scale `c` (wall s
 *    per G unit) captures voice + GPU load.
 *  - `c` is observed in-stream as the MEDIAN slope dWall/dG over arrivals
 *    (robust to one stall), blended with the per-voice calibrated `c`
 *    (weight G/(G + OBS_PRIOR_G)), inflated by a learned per-voice bias and
 *    a margin. Cold with one arrival: wait (null).
 *  - Length prior: T = LEN_A + chars / LEN_CPS (fit on live traces), scaled
 *    by the per-voice learned length ratio, plus a learned spread margin.
 *  - Start time: the earliest time t such that every future position x
 *    (grid GRID) — audible only once its whole CHUNK_S server chunk is in —
 *    arrives before it is due, with the future anchored at the LATEST
 *    arrival (a past stall is paid once, not extrapolated), plus
 *    ABS_MARGIN. Stream end → −Infinity (flush now).
 *  - Calibration is per engine:voice, EWMA'd (fast toward slower), updated
 *    only from streams long enough to measure, persisted in localStorage
 *    for 7 days.
 */

/** Relative in-sentence slowdown per audio second: g(x) = c·(1 + KAPPA·x). */
export const KAPPA = 0.12;
/** Server emit quantum: a position is audible only once its chunk arrived. */
export const CHUNK_S = 0.5;
/** Length prior T = LEN_A + chars / LEN_CPS. */
export const LEN_A = 0.56;
export const LEN_CPS = 26.4;
/** Cold (uncalibrated) pessimism on the length estimate. */
export const LEN_MARGIN_COLD = 0;
/** Warm length margin = LEN_DEV_K × EWMA |scale − mean| (Jacobson/Karels). */
export const LEN_DEV_K = 1;
export const LEN_DEV_INIT = 0.08;
export const LEN_DEV_BETA = 0.25;
export const ALPHA_LEN = 0.5;
/** Pessimism on the speed scale c: cold / warm / per underrun suffered. */
export const C_MARGIN_COLD = 0.09;
export const C_MARGIN_WARM = 0.06;
export const C_MARGIN_PER_UNDERRUN = 0.1;
/** Absolute headroom on the start time (s). */
export const ABS_MARGIN = 0.1;
/** Observation weight: w = G(X) / (G(X) + OBS_PRIOR_G). */
export const OBS_PRIOR_G = 0.25;
/** Grid step for the max over future positions (s). */
export const GRID = 0.05;
/** History EWMA toward slower / toward faster. */
export const ALPHA_SLOWER = 0.6;
export const ALPHA_FASTER = 0.3;
/** Texts shorter than this never update the length scale. */
export const MIN_LEN_CHARS = 25;
/** Streams with less audio than this never update c. */
export const MIN_HIST_S = 1.5;
/** Observation span (G units) that defines the "early" c for the bias. */
export const BIAS_SPAN_G = 1.5;
/** Arrivals closer than this to the previous one are a burst, not a rate sample. */
const BURST_GAP_S = 0.02;

/** One network arrival: clock time (s) and audio length (s). */
export interface TimedArrival {
  t: number;
  s: number;
}

/** Rough audio length a text will synthesize to (uncalibrated prior). */
export function estimateSpeechSeconds(text: string | number): number {
  const chars = typeof text === "number" ? text : text.trim().length;
  return LEN_A + chars / LEN_CPS;
}

/** Wall time (units of c) from the first arrival until position x exists. */
export function G(x: number, x1: number): number {
  return Math.max(0, x - x1) + (KAPPA / 2) * Math.max(0, x * x - x1 * x1);
}

/** [G reached, wall since first arrival] at every non-burst arrival. */
function profilePoints(
  arrivals: readonly TimedArrival[],
  maxG = Number.POSITIVE_INFINITY,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [[0, 0]];
  if (arrivals.length === 0) return pts;
  const t0 = arrivals[0].t;
  const x1 = arrivals[0].s;
  let x = 0;
  for (let i = 0; i < arrivals.length; i++) {
    x += arrivals[i].s;
    const g = G(x, x1);
    if (g > maxG) break;
    if (i > 0 && arrivals[i].t - arrivals[i - 1].t > BURST_GAP_S) {
      pts.push([g, arrivals[i].t - t0]);
    }
  }
  return pts;
}

/**
 * Observed speed scale c: the MEDIAN of per-interval slopes dWall/dG, so
 * one stall (or one burst) does not move it. Null with no usable interval.
 */
export function observedSpeedScale(
  pts: ReadonlyArray<readonly [number, number]>,
): number | null {
  const slopes: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dg = pts[i][0] - pts[i - 1][0];
    if (dg > 0.05) slopes.push((pts[i][1] - pts[i - 1][1]) / dg);
  }
  if (slopes.length === 0) return null;
  slopes.sort((a, b) => a - b);
  const m = slopes.length >> 1;
  return slopes.length % 2 ? slopes[m] : (slopes[m - 1] + slopes[m]) / 2;
}

/** Oracle: minimal gapless start offset from the first arrival. */
export function oracleOffset(arrivals: readonly TimedArrival[]): number {
  if (arrivals.length === 0) return 0;
  const t0 = arrivals[0].t;
  let audio = 0;
  let need = 0;
  for (const a of arrivals) {
    need = Math.max(need, a.t - t0 - audio);
    audio += a.s;
  }
  return need;
}

// ---------------------------------------------------------------------------
// Calibration (per engine:voice)
// ---------------------------------------------------------------------------

export interface VoiceCalibration {
  /** Calibrated speed scale (wall s per G unit), null if never measured. */
  c: number | null;
  /** Actual / prior length ratio. */
  lenScale: number | null;
  /** EWMA |lenScale deviation|. */
  lenDev: number | null;
  /** Learned sufficient-c / early-observed-c ratio. */
  bias: number | null;
  /** Epoch ms of the last update (persistence expiry). */
  updatedAt?: number;
}

export interface BridgeCalibration {
  voices: Record<string, VoiceCalibration>;
  /** Most recent c from any voice — a warm GPU hint for a new voice. */
  lastC: number | null;
  lastAt?: number;
}

/** What {@link startAt} needs from calibration for one voice. */
export interface CalibrationView {
  c: number | null;
  lenScale: number | null;
  lenDev: number | null;
  bias: number;
}

export function createCalibration(): BridgeCalibration {
  return { voices: {}, lastC: null };
}

export function calFor(
  cal: BridgeCalibration,
  voiceKey: string,
): CalibrationView {
  const v = cal.voices[voiceKey];
  return {
    c: v?.c ?? cal.lastC,
    lenScale: v?.lenScale ?? null,
    lenDev: v?.lenDev ?? null,
    bias: v?.bias ?? 1,
  };
}

/** Planned start offset for the rest of the stream (bisection helper). */
function requiredOffset(c: number, x1: number, from: number, T: number) {
  let s = Number.NEGATIVE_INFINITY;
  for (let x = from; x <= T + 1e-9; x += GRID) {
    s = Math.max(s, c * G(Math.min(x + CHUNK_S, T), x1) - x);
  }
  return s;
}

/**
 * Fold a completed stream into the calibration for `voiceKey`. Short texts
 * (< MIN_LEN_CHARS) never touch the length scale; streams with less than
 * MIN_HIST_S of audio or fewer than 3 arrivals never touch c — a "Sure."
 * says nothing about either.
 */
export function updateCalibration(
  cal: BridgeCalibration,
  voiceKey: string,
  arrivals: readonly TimedArrival[],
  chars: number,
  nowMs = Date.now(),
): void {
  if (arrivals.length === 0) return;
  const total = arrivals.reduce((sum, a) => sum + a.s, 0);
  const lenOk = chars >= MIN_LEN_CHARS;
  const cOk = total >= MIN_HIST_S && arrivals.length >= 3;
  if (!lenOk && !cOk) return;
  cal.voices[voiceKey] ??= {
    c: null,
    lenScale: null,
    lenDev: null,
    bias: null,
  };
  const v = cal.voices[voiceKey];
  v.updatedAt = nowMs;
  if (lenOk) {
    const scale = total / estimateSpeechSeconds(chars);
    if (v.lenScale == null) {
      v.lenScale = scale;
      v.lenDev = LEN_DEV_INIT;
    } else {
      v.lenDev =
        (1 - LEN_DEV_BETA) * (v.lenDev ?? LEN_DEV_INIT) +
        LEN_DEV_BETA * Math.abs(scale - v.lenScale);
      v.lenScale = v.lenScale + ALPHA_LEN * (scale - v.lenScale);
    }
  }
  if (!cOk) return;
  // Sufficient c: the smallest c whose model offset (with the TRUE length)
  // covers what the stream actually needed.
  const x1 = arrivals[0].s;
  const need = oracleOffset(arrivals);
  let lo = 0.05;
  let hi = 5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (requiredOffset(mid, x1, x1, total) >= need) hi = mid;
    else lo = mid;
  }
  let cs = hi;
  if (need < 0.02) {
    // Never needed a buffer: remember its actual speed (LS fit), not the
    // break-even c.
    let num = 0;
    let den = 0;
    let x = 0;
    for (let i = 0; i < arrivals.length; i++) {
      x += arrivals[i].s;
      if (i > 0) {
        const g = G(x, x1);
        num += g * (arrivals[i].t - arrivals[0].t);
        den += g * g;
      }
    }
    if (den > 0) cs = Math.min(cs, num / den);
  }
  // Estimator bias: how much slower the stream turned out than its early
  // slope said.
  const early = observedSpeedScale(profilePoints(arrivals, BIAS_SPAN_G));
  if (early !== null && need >= 0.02) {
    const b = cs / early;
    v.bias =
      v.bias == null
        ? b
        : v.bias + (b > v.bias ? ALPHA_SLOWER : ALPHA_FASTER) * (b - v.bias);
  }
  v.c =
    v.c == null
      ? cs
      : v.c + (cs < v.c ? ALPHA_FASTER : ALPHA_SLOWER) * (cs - v.c);
  cal.lastC = v.c;
  cal.lastAt = nowMs;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface StartState {
  /** Arrivals so far, TRUE arrival times on the same clock as `now`. */
  arrivals: readonly TimedArrival[];
  now: number;
  /** The server closed the body. */
  done: boolean;
  /** Characters of the text this stream speaks. */
  chars: number;
  /** Audio already handed to the clock. */
  scheduled: number;
  /** Underruns suffered so far this stream. */
  underruns: number;
  cal: CalibrationView;
}

/**
 * Earliest clock time at which (re)starting playback is predicted
 * gapless. `null`: nothing can be predicted yet (cold, one arrival) —
 * wait for more. `-Infinity`: the stream is done, flush now.
 */
export function startAt(state: StartState): number | null {
  const { arrivals, now, done, chars, scheduled, underruns, cal } = state;
  if (arrivals.length === 0) return null;
  if (done) return Number.NEGATIVE_INFINITY;
  const t0 = arrivals[0].t;
  const x1 = arrivals[0].s;
  let X = 0;
  let past = Number.NEGATIVE_INFINITY;
  for (const a of arrivals) {
    past = Math.max(past, a.t - t0 - X);
    X += a.s;
  }
  const pts = profilePoints(arrivals);
  const warm = cal.c != null;
  const lenMargin =
    cal.lenScale != null
      ? LEN_DEV_K * (cal.lenDev ?? LEN_DEV_INIT)
      : LEN_MARGIN_COLD;
  let T = estimateSpeechSeconds(chars) * (cal.lenScale ?? 1) * (1 + lenMargin);
  if (T < X + CHUNK_S) T = X + CHUNK_S;
  const cObs = observedSpeedScale(pts);
  const gSpan = pts[pts.length - 1][0];
  let c: number;
  if (cObs === null) {
    if (cal.c == null) return null;
    c = cal.c;
  } else if (cal.c == null) {
    c = cObs;
  } else {
    const w = gSpan / (gSpan + OBS_PRIOR_G);
    c = w * cObs + (1 - w) * cal.c;
  }
  const cMargin =
    (warm || pts.length >= 4 ? C_MARGIN_WARM : C_MARGIN_COLD) +
    C_MARGIN_PER_UNDERRUN * underruns;
  const cPlan = c * Math.max(1, cal.bias) * (1 + cMargin);
  // Anchor the future at the LATEST arrival; if the next chunk is already
  // overdue the stall is still going, so push the anchor to now.
  const gX = G(X, x1);
  let anchor = pts[pts.length - 1][1];
  const dueNext = anchor + cPlan * (G(Math.min(X + CHUNK_S, T), x1) - gX);
  if (now - t0 > dueNext) anchor += now - t0 - dueNext;
  let off = Number.NEGATIVE_INFINITY;
  for (let x = X; x <= T + 1e-9; x += GRID) {
    off = Math.max(
      off,
      anchor + cPlan * (G(Math.min(x + CHUNK_S, T), x1) - gX) - x,
    );
  }
  return t0 + Math.max(off + scheduled, past) + ABS_MARGIN;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const CALIBRATION_STORAGE_KEY = "buzz.tts.jb.v1";
export const CALIBRATION_VERSION = 1;
export const CALIBRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The subset of `Storage` persistence needs (tests pass a Map shim). */
export interface CalibrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): CalibrationStorage | null {
  // Browser only: reading `localStorage` on Node warns (no storage file).
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Load the persisted calibration, dropping voices not updated within 7
 * days (a GPU's load and a voice's pace drift). Anything unreadable, from
 * another version, or absent yields a fresh calibration.
 */
export function loadCalibration(
  storage: CalibrationStorage | null = defaultStorage(),
  nowMs = Date.now(),
): BridgeCalibration {
  const cal = createCalibration();
  if (storage === null) return cal;
  let raw: unknown;
  try {
    const text = storage.getItem(CALIBRATION_STORAGE_KEY);
    if (text === null) return cal;
    raw = JSON.parse(text);
  } catch {
    return cal;
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { v?: unknown }).v !== CALIBRATION_VERSION
  ) {
    return cal;
  }
  const data = raw as {
    voices?: Record<string, Record<string, unknown>>;
    lastC?: unknown;
    lastAt?: unknown;
  };
  const fresh = (at: unknown) =>
    typeof at === "number" && nowMs - at <= CALIBRATION_TTL_MS;
  for (const [key, v] of Object.entries(data.voices ?? {})) {
    if (!v || !fresh(v.updatedAt)) continue;
    cal.voices[key] = {
      c: finiteOrNull(v.c),
      lenScale: finiteOrNull(v.lenScale),
      lenDev: finiteOrNull(v.lenDev),
      bias: finiteOrNull(v.bias),
      updatedAt: v.updatedAt as number,
    };
  }
  if (fresh(data.lastAt)) {
    cal.lastC = finiteOrNull(data.lastC);
    cal.lastAt = data.lastAt as number;
  }
  return cal;
}

/** Persist the calibration; storage failures are ignored (best effort). */
export function saveCalibration(
  cal: BridgeCalibration,
  storage: CalibrationStorage | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      CALIBRATION_STORAGE_KEY,
      JSON.stringify({
        v: CALIBRATION_VERSION,
        voices: cal.voices,
        lastC: cal.lastC,
        lastAt: cal.lastAt,
      }),
    );
  } catch {
    // Quota / private mode: calibration just stays in memory.
  }
}

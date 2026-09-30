import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  createRateHistory,
  estimateSpeechSeconds,
  planningRate,
  prebufferTarget,
  shouldStartPlayback,
  sufficientRate,
  updateRateHistory,
} from "./bridgeJitterBuffer.ts";
import { BRIDGE_SAMPLE_RATE, playBridgeResponse } from "./bridgeSpeech.ts";

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

const base = {
  bufferedSeconds: 0,
  receivedSeconds: 0,
  scheduledSeconds: 0,
  arrivedAfterFirstSeconds: 0,
  elapsedSeconds: 0,
  underruns: 0,
  expectedSeconds: null,
  historyRate: null,
  lengthScale: null,
  streamDone: false,
};

test("policy: initial prebuffer is 0.4 s when the rate is unknown or healthy", () => {
  assert.equal(prebufferTarget(base), 0.4);
  // Healthy measured rate (3x real time) keeps the small target even with
  // a long expected utterance.
  assert.equal(
    prebufferTarget({
      ...base,
      arrivedAfterFirstSeconds: 3,
      elapsedSeconds: 1,
      expectedSeconds: 10,
    }),
    0.4,
  );
  const fast = { ...base, arrivedAfterFirstSeconds: 0.9, elapsedSeconds: 0.3 };
  assert.equal(shouldStartPlayback({ ...fast, bufferedSeconds: 0.39 }), false);
  assert.equal(shouldStartPlayback({ ...fast, bufferedSeconds: 0.4 }), true);
});

test("policy: cold start waits for a measurable rate, history or stream end", () => {
  // No history, rate window not yet closed: plenty buffered still waits.
  const early = { ...base, bufferedSeconds: 2, elapsedSeconds: 0.1 };
  assert.equal(shouldStartPlayback(early), false);
  assert.equal(shouldStartPlayback({ ...early, historyRate: 1.5 }), true);
  assert.equal(shouldStartPlayback({ ...early, streamDone: true }), true);
});

test("policy: planning rate is pessimistic — min(observed, history), derated cold", () => {
  const measured = {
    ...base,
    arrivedAfterFirstSeconds: 1.05,
    elapsedSeconds: 1,
  };
  assert.equal(planningRate({ ...measured, historyRate: 0.76 }), 0.76);
  assert.equal(planningRate({ ...measured, historyRate: 1.4 }), 1.05);
  assert.equal(planningRate({ ...base, historyRate: 0.8 }), 0.8);
  assert.ok(Math.abs(planningRate(measured) - 1.05 / 1.25) < 1e-9);
  assert.equal(planningRate(base), null);
});

test("policy: a slow history rate sizes the INITIAL buffer to the utterance", () => {
  // rate 0.5, 6 s expected: 6 × (1 − 0.5) × 1.1 = 3.3 s.
  const t = prebufferTarget({ ...base, historyRate: 0.5, expectedSeconds: 6 });
  assert.ok(Math.abs(t - 3.3) < 1e-9, `got ${t}`);
  // The remembered length calibration scales the estimate (×0.5 → 1.65).
  const scaled = prebufferTarget({
    ...base,
    historyRate: 0.5,
    expectedSeconds: 6,
    lengthScale: 0.5,
  });
  assert.ok(Math.abs(scaled - 1.65) < 1e-9, `got ${scaled}`);
});

test("policy: rebuffer target covers the remaining audio at the observed rate", () => {
  // 2 s already scheduled of 8 expected → 6 s remain; rate 0.6 (observed
  // and remembered) → 6 × 0.4 × 1.1 = 2.64 s.
  const t = prebufferTarget({
    ...base,
    historyRate: 0.6,
    underruns: 1,
    scheduledSeconds: 2,
    receivedSeconds: 2.2,
    arrivedAfterFirstSeconds: 1.2,
    elapsedSeconds: 2,
    expectedSeconds: 8,
  });
  assert.ok(Math.abs(t - 2.64) < 1e-9, `got ${t}`);
});

test("policy: rebuffer floor doubles with each underrun", () => {
  assert.equal(prebufferTarget({ ...base, underruns: 1 }), 0.4);
  assert.equal(prebufferTarget({ ...base, underruns: 2 }), 0.8);
  assert.equal(prebufferTarget({ ...base, underruns: 3 }), 1.6);
});

test("policy: stream end always flushes, empty buffer never starts", () => {
  assert.equal(
    shouldStartPlayback({
      ...base,
      bufferedSeconds: 0.01,
      underruns: 3,
      streamDone: true,
    }),
    true,
  );
  assert.equal(shouldStartPlayback({ ...base, streamDone: true }), false);
});

test("estimateSpeechSeconds assumes a typical 15 chars/s before calibration", () => {
  assert.equal(estimateSpeechSeconds("x".repeat(150)), 10);
  assert.equal(estimateSpeechSeconds("   "), 0);
});

// ---------------------------------------------------------------------------
// Scheduler simulation: real playBridgeResponse, virtual clock
// ---------------------------------------------------------------------------

/**
 * Drive playBridgeResponse with a stream whose chunks arrive on a VIRTUAL
 * clock: `chunkSeconds` of audio every `chunkSeconds × rtf` wall seconds
 * (rtf > 1 = slower than real time). `highWaterMark: 0` makes the stream
 * pull only when the scheduler reads, so each read advances the clock to
 * that chunk's arrival time. Returns every scheduled piece.
 */
async function simulate({
  totalSeconds,
  chunkSeconds,
  rtf,
  firstByteSeconds = 0.3,
  startAt = 0,
  jitter,
  stopAfterReads = null,
  hiccup = null,
}) {
  let now = startAt;
  const pieces = [];
  const sources = [];
  const ctx = {
    get currentTime() {
      return now;
    },
    destination: {},
    createBuffer: (_c, length) => ({ length, copyToChannel() {} }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        connect() {},
        start(when) {
          pieces.push({ when, dur: this.buffer.length / BRIDGE_SAMPLE_RATE });
        },
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  const chunkBytes = Math.round(chunkSeconds * BRIDGE_SAMPLE_RATE) * 2;
  const totalBytes = Math.round(totalSeconds * BRIDGE_SAMPLE_RATE) * 2;
  let sent = 0;
  let reads = 0;
  let stopped = false;
  const arrivals = [];
  const body = new ReadableStream(
    {
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        now =
          startAt +
          firstByteSeconds +
          (sent / 2 / BRIDGE_SAMPLE_RATE) * rtf +
          (hiccup !== null && reads >= hiccup.fromRead ? hiccup.seconds : 0);
        const n = Math.min(chunkBytes, totalBytes - sent);
        arrivals.push(now);
        controller.enqueue(new Uint8Array(n));
        sent += n;
        reads += 1;
        if (stopAfterReads !== null && reads >= stopAfterReads) stopped = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await playBridgeResponse({ body }, ctx, {
    shouldStop: () => stopped,
    scheduleSettle: (_ms, fn) => {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    },
    jitter,
  });
  return { pieces, sources, arrivals, result, end: now };
}

/** Count silent gaps between consecutive scheduled pieces. */
function gapsIn(pieces) {
  const sorted = [...pieces].sort((a, b) => a.when - b.when);
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].when + sorted[i - 1].dur;
    if (sorted[i].when - prevEnd > 1e-6) gaps += 1;
  }
  return gaps;
}

function totalScheduled(pieces) {
  return pieces.reduce((sum, p) => sum + p.dur, 0);
}

test("sufficientRate: the rate a trace NEEDED, not its average", () => {
  // Decelerating: 0.5 s chunks at 0, 0.5, 1.1, 1.8, 2.6 (2.5 s audio).
  // Required delay = max(t_i − audio before i) = max(0, 0, 0.1, 0.3, 0.6)
  // = 0.6 → audio buffered by then = 1.0 → r = 1 − 1.0/2.5 = 0.6.
  const decel = [0, 0.5, 1.1, 1.8, 2.6].map((t) => ({ t, seconds: 0.5 }));
  assert.ok(Math.abs(sufficientRate(decel) - 0.6) < 1e-9);
  // Its average after the first read is 2.0/2.6 ≈ 0.77 — optimistic.
  // A fast trace never needed a buffer: returns its average, ≥ 1.
  const fast = [0, 0.1, 0.2, 0.3].map((t) => ({ t, seconds: 0.5 }));
  assert.ok(Math.abs(sufficientRate(fast) - 5) < 1e-9);
  assert.equal(sufficientRate([{ t: 0, seconds: 1 }]), null);
});

test("updateRateHistory: EWMA fast toward slower, slow toward faster; short streams ignored", () => {
  const h = createRateHistory();
  const decel = [0, 0.5, 1.1, 1.8, 2.6].map((t) => ({ t, seconds: 0.5 }));
  updateRateHistory(h, { arrivals: decel, expectedSeconds: 5 });
  assert.ok(Math.abs(h.rate - 0.6) < 1e-9);
  assert.ok(Math.abs(h.lengthScale - 0.5) < 1e-9);
  // Faster stream (rate 5): moves 30 % of the way → 0.6 + 0.3 × 4.4 = 1.92.
  const fast = [0, 0.1, 0.2, 0.3].map((t) => ({ t, seconds: 0.5 }));
  updateRateHistory(h, { arrivals: fast });
  assert.ok(Math.abs(h.rate - 1.92) < 1e-9, `rate ${h.rate}`);
  // Slower again (0.6): moves 70 % → 1.92 − 0.7 × 1.32 = 0.996.
  updateRateHistory(h, { arrivals: decel });
  assert.ok(Math.abs(h.rate - 0.996) < 1e-9, `rate ${h.rate}`);
  // "Sure." — 0.69 s of audio — changes nothing.
  const before = { ...h };
  const sure = [0, 0.3, 0.31].map((t) => ({ t, seconds: 0.23 }));
  updateRateHistory(h, { arrivals: sure, expectedSeconds: 0.33 });
  assert.deepEqual(h, before);
});

test("jitter: healthy Chatterbox-sized chunks (0.45 s every 0.15 s) start within 0.5 s", async () => {
  const { pieces, arrivals } = await simulate({
    totalSeconds: 5,
    chunkSeconds: 0.45,
    rtf: 1 / 3,
    jitter: { expectedSeconds: 7 },
  });
  assert.ok(pieces.length >= 15, `count guard: ${pieces.length}`);
  const startDelay = pieces[0].when - arrivals[0];
  assert.ok(startDelay <= 0.5, `healthy delay ${startDelay}s`);
  assert.equal(gapsIn(pieces), 0);
});

test("sim harness: the gap counter detects a gap (and only a gap)", () => {
  assert.equal(
    gapsIn([
      { when: 0, dur: 0.2 },
      { when: 0.3, dur: 0.2 },
      { when: 0.5, dur: 0.2 },
    ]),
    1,
  );
  assert.equal(
    gapsIn([
      { when: 0, dur: 0.2 },
      { when: 0.2, dur: 0.2 },
    ]),
    0,
  );
});

test("jitter: a fast stream starts within the small initial threshold, gapless", async () => {
  // Healthy Chatterbox: 3x faster than real time, 0.1 s chunks.
  const { pieces, arrivals, result } = await simulate({
    totalSeconds: 6,
    chunkSeconds: 0.1,
    rtf: 0.3,
  });
  assert.ok(pieces.length >= 20, `count guard: ${pieces.length}`);
  assert.ok(Math.abs(result.seconds - 6) < 1e-6);
  assert.ok(Math.abs(totalScheduled(pieces) - 6) < 1e-6);
  const startDelay = pieces[0].when - arrivals[0];
  // Cold start waits out the 0.25 s rate window (+20 ms schedule lead);
  // the rate (3x) then clears the derate and the 0.4 s floor is met.
  // schedule lead). Bound it loosely at 0.2 s.
  assert.ok(startDelay <= 0.35, `fast path added ${startDelay}s`);
  assert.equal(gapsIn(pieces), 0);
});

test("jitter: one network hiccup on a healthy stream costs little latency and no gaps", async () => {
  // 3x real time, but the 2nd chunk is 150 ms late — the first rate sample
  // reads as slow. Later arrivals must pull the target back down.
  const { pieces, arrivals } = await simulate({
    totalSeconds: 6,
    chunkSeconds: 0.1,
    rtf: 0.3,
    hiccup: { fromRead: 1, seconds: 0.15 },
    jitter: { expectedSeconds: 6.5 },
  });
  assert.ok(pieces.length >= 20, `count guard: ${pieces.length}`);
  const startDelay = pieces[0].when - arrivals[0];
  assert.ok(startDelay <= 0.6, `hiccup delay ${startDelay}s`);
  assert.equal(gapsIn(pieces), 0);
});

test("jitter: tonight's slow stream (6.2 s over 7.9 s) is a short delay then gapless", async () => {
  const { pieces, arrivals, result } = await simulate({
    totalSeconds: 6.2,
    chunkSeconds: 0.25,
    rtf: 7.9 / 6.2,
    // The player's hint for a ~75-char sentence.
    jitter: { expectedSeconds: estimateSpeechSeconds("x".repeat(75)) },
  });
  assert.ok(pieces.length >= 20, `count guard: ${pieces.length}`);
  assert.ok(Math.abs(result.seconds - 6.2) < 1e-6);
  // The rate is measurable by the second arrival, so the INITIAL buffer is
  // already sized for the whole sentence: no rebuffer at all.
  assert.equal(gapsIn(pieces), 0, `gaps: ${gapsIn(pieces)}`);
  const startDelay = pieces[0].when - arrivals[0];
  // Cold (no history) and the text estimate under-shoots (5.0 s vs 6.2 s):
  // the derate carries it. Accepted first-sentence delay on a slow GPU.
  assert.ok(startDelay < 3, `slow path delay ${startDelay}s`);
});

test("jitter: a very slow stream (rtf 1.9) with the text hint plays gapless", async () => {
  const { pieces } = await simulate({
    totalSeconds: 5,
    chunkSeconds: 0.2,
    rtf: 1.9,
    jitter: { expectedSeconds: estimateSpeechSeconds("x".repeat(62)) },
  });
  assert.ok(pieces.length >= 20, `count guard: ${pieces.length}`);
  assert.ok(Math.abs(totalScheduled(pieces) - 5) < 1e-6);
  assert.equal(gapsIn(pieces), 0, `gaps: ${gapsIn(pieces)}`);
});

test("jitter: with NO hints a very slow stream still converges (doubling floor)", async () => {
  // Without a length estimate the remaining audio is unknowable; the
  // doubling floor bounds the stutter instead of eliminating it. Every
  // production caller passes a hint — this pins the fallback only.
  const { pieces } = await simulate({
    totalSeconds: 5,
    chunkSeconds: 0.2,
    rtf: 1.9,
  });
  assert.ok(pieces.length >= 20, `count guard: ${pieces.length}`);
  assert.ok(Math.abs(totalScheduled(pieces) - 5) < 1e-6);
  assert.ok(gapsIn(pieces) <= 2, `gaps: ${gapsIn(pieces)}`);
});

test("jitter: once the slow rate is known, the NEXT sentence is gapless from the start", async () => {
  const history = createRateHistory();
  await simulate({
    totalSeconds: 4,
    chunkSeconds: 0.2,
    rtf: 1.6,
    jitter: { expectedSeconds: 4.5, history },
  });
  assert.ok(history.rate !== null && history.rate < 1, `rate ${history.rate}`);
  // 0.5 s chunks: the FIRST read already exceeds the 0.4 s initial target,
  // before any in-stream rate exists — only the history can hold it back.
  const { pieces } = await simulate({
    totalSeconds: 5,
    chunkSeconds: 0.5,
    rtf: 1.6,
    startAt: 100,
    jitter: { expectedSeconds: 5.5, history },
  });
  assert.ok(pieces.length >= 10, `count guard: ${pieces.length}`);
  assert.equal(gapsIn(pieces), 0);
});

test("jitter: an interrupt during the prebuffer drops unscheduled audio", async () => {
  // Slow stream; stop after 1 read (0.2 s buffered, below 0.4 s): nothing
  // may ever reach the clock.
  const { sources, result } = await simulate({
    totalSeconds: 5,
    chunkSeconds: 0.2,
    rtf: 1.5,
    stopAfterReads: 1,
  });
  assert.equal(sources.length, 0, "buffered audio must not be scheduled");
  assert.equal(result.seconds, 0);
});

// ---------------------------------------------------------------------------
// Live-trace replay: REAL Chatterbox arrival timing (QA, 2026-09-29, GPU
// contended), replayed through the real playBridgeResponse on a virtual
// clock. ~0.45 s chunks at roughly real time at first, slowing to 0.6–0.7 s
// spacing — the deceleration the policy must survive.
// ---------------------------------------------------------------------------

const TRACE_DIR = new URL("./__fixtures__/bridge-traces/", import.meta.url);
const LIVE_TEXT =
  "The quarterly numbers look solid, and I think we should ship the release on Thursday after the final review.";

function loadTrace(name) {
  return JSON.parse(readFileSync(new URL(name, TRACE_DIR), "utf8"));
}

async function replayTrace(name, text, history) {
  const trace = loadTrace(name);
  let now = 0;
  const pieces = [];
  const ctx = {
    get currentTime() {
      return now;
    },
    destination: {},
    createBuffer: (_c, length) => ({ length, copyToChannel() {} }),
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      start(when) {
        pieces.push({ when, dur: this.buffer.length / BRIDGE_SAMPLE_RATE });
      },
      stop() {},
    }),
  };
  let i = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        const read = trace.arr[i++];
        now = read.t;
        if (read.done) controller.close();
        else controller.enqueue(new Uint8Array(read.bytes));
      },
    },
    { highWaterMark: 0 },
  );
  await playBridgeResponse({ body }, ctx, {
    scheduleSettle: (_ms, fn) => {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    },
    jitter: {
      expectedSeconds: estimateSpeechSeconds(text),
      ...(history ? { history } : {}),
    },
  });
  const sorted = [...pieces].sort((a, b) => a.when - b.when);
  const gapList = [];
  for (let k = 1; k < sorted.length; k++) {
    const gap = sorted[k].when - (sorted[k - 1].when + sorted[k - 1].dur);
    if (gap > 1e-6) gapList.push(gap);
  }
  const result = {
    pieces: sorted.length,
    audio: totalScheduled(sorted),
    startDelay: sorted[0].when - trace.arr[0].t,
    gaps: gapList.length,
    maxGap: gapList.length === 0 ? 0 : Math.max(...gapList),
  };
  if (process.env.JB_REPLAY_LOG) {
    console.log(
      `REPLAY ${name} ${JSON.stringify(result)} ${JSON.stringify(history ?? null)}`,
    );
  }
  return result;
}

for (const name of ["live1.json", "live2.json"]) {
  test(`replay ${name}: first sentence (no history) — at most one gap < 0.3 s`, async () => {
    const r = await replayTrace(name, LIVE_TEXT);
    assert.ok(r.pieces >= 15, `count guard: ${r.pieces}`);
    assert.ok(r.audio > 4.5, `audio ${r.audio}`);
    assert.ok(
      r.gaps === 0 || (r.gaps === 1 && r.maxGap < 0.3),
      `gaps ${r.gaps}, max ${r.maxGap.toFixed(3)} s`,
    );
    assert.ok(r.startDelay < 2.2, `start delay ${r.startDelay.toFixed(2)} s`);
  });
}

for (const [first, second] of [
  ["live1.json", "live2.json"],
  ["live2.json", "live1.json"],
]) {
  test(`replay ${first} → ${second}: second sentence with history is gapless`, async () => {
    const history = createRateHistory();
    await replayTrace(first, LIVE_TEXT, history);
    assert.ok(
      history.rate !== null && history.rate < 1,
      `rate ${history.rate}`,
    );
    const r = await replayTrace(second, LIVE_TEXT, history);
    assert.ok(r.pieces >= 15, `count guard: ${r.pieces}`);
    assert.equal(r.gaps, 0, `gaps ${r.gaps}, max ${r.maxGap.toFixed(3)} s`);
  });
}

test('replay: a short "Sure." does not overwrite a slow remembered rate', async () => {
  const history = createRateHistory();
  await replayTrace("live1.json", LIVE_TEXT, history);
  const remembered = { ...history };
  await replayTrace("live_short.json", "Sure.", history);
  assert.deepEqual(history, remembered, "short stream must not update history");
  const r = await replayTrace("live2.json", LIVE_TEXT, history);
  assert.equal(r.gaps, 0, `gaps ${r.gaps}, max ${r.maxGap.toFixed(3)} s`);
});

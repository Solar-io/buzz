import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRateHistory,
  estimateSpeechSeconds,
  prebufferTarget,
  shouldStartPlayback,
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
  assert.equal(shouldStartPlayback({ ...base, bufferedSeconds: 0.39 }), false);
  assert.equal(shouldStartPlayback({ ...base, bufferedSeconds: 0.4 }), true);
});

test("policy: a slow history rate sizes the INITIAL buffer to the utterance", () => {
  // rate 0.5, 6 s expected: 6 × (1 − 0.5) × 1.25 = 3.75 s.
  assert.equal(
    prebufferTarget({ ...base, historyRate: 0.5, expectedSeconds: 6 }),
    3.75,
  );
});

test("policy: rebuffer target covers the remaining audio at the observed rate", () => {
  // 2 s already scheduled of 8 expected → 6 s remain; rate 0.6 →
  // 6 × 0.4 × 1.25 = 3 s.
  const t = prebufferTarget({
    ...base,
    underruns: 1,
    scheduledSeconds: 2,
    receivedSeconds: 2.2,
    arrivedAfterFirstSeconds: 1.2,
    elapsedSeconds: 2,
    expectedSeconds: 8,
  });
  assert.ok(Math.abs(t - 3) < 1e-9, `got ${t}`);
});

test("policy: rebuffer floor doubles with each underrun", () => {
  assert.equal(prebufferTarget({ ...base, underruns: 1 }), 1);
  assert.equal(prebufferTarget({ ...base, underruns: 2 }), 2);
  assert.equal(prebufferTarget({ ...base, underruns: 3 }), 4);
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

test("estimateSpeechSeconds assumes a deliberately slow 12 chars/s", () => {
  assert.equal(estimateSpeechSeconds("x".repeat(120)), 10);
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
  // 0.4 s of audio at rtf 0.3 lands in 0.09 s after the first chunk (+20 ms
  // schedule lead). Bound it loosely at 0.2 s.
  assert.ok(startDelay <= 0.2, `fast path added ${startDelay}s`);
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
  assert.ok(startDelay < 2.5, `slow path delay ${startDelay}s`);
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

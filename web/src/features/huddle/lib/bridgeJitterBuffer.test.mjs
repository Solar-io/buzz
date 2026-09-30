import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CALIBRATION_STORAGE_KEY,
  calFor,
  createCalibration,
  estimateSpeechSeconds,
  loadCalibration,
  observedSpeedScale,
  oracleOffset,
  saveCalibration,
  startAt,
  updateCalibration,
} from "./bridgeJitterBuffer.ts";
import {
  BRIDGE_SAMPLE_RATE,
  drainTimed,
  playBridgeResponse,
  recentBridgeStreams,
} from "./bridgeSpeech.ts";

// ---------------------------------------------------------------------------
// Fixtures: 22 REAL Chatterbox arrival traces (QA + architect, 2026-09-29,
// GPU contended), voice and text embedded. `arr[].t` is seconds since the
// request; `tHdr` the headers time.
// ---------------------------------------------------------------------------

const TRACE_DIR = new URL("./__fixtures__/bridge-traces/", import.meta.url);
const TRACES = Object.fromEntries(
  readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const d = JSON.parse(readFileSync(new URL(f, TRACE_DIR), "utf8"));
      return [d.name, d];
    }),
);

/** Trace → policy arrivals [{t, s}] (audio seconds). */
function arrivalsOf(trace) {
  return trace.arr
    .filter((a) => !a.done && a.bytes > 0)
    .map((a) => ({ t: a.t, s: Math.floor(a.bytes / 2) / BRIDGE_SAMPLE_RATE }));
}

const voiceKey = (voice) => `chatterbox:${voice}`;

/**
 * Oracle gapless start delay (s from first arrival) per fixture, from the
 * architect's table (`table_md.txt`, "ideal start") — hardcoded, not
 * derived, so a change to oracleOffset cannot move its own goalposts.
 */
const IDEAL = {
  r3_s1_jared: 1.08,
  r3_s2_jared: 1.1,
  live1_jared: 0.95,
  r3_s1_trevor: 1.48,
  med_jay: 1.35,
  short_jared: 0.34,
  live_short_jared: 0.06,
  live2_jared: 1.14,
  med_trevor: 1.58,
  r3_s2_trevor: 2.23,
  r3_s3_jared: 1.03,
  r3_s3_trevor: 2.96,
  r3_whole_jared: 5.06,
  short_jay: 0.22,
  freshp1A_trevor: 1.54,
  freshp1B_trevor: 4.07,
  freshp2A_jay: 0.75,
  freshp2B_jay: 0.98,
  freshp3A_jared: 0.89,
  freshp3B_jared: 1.4,
  freshp4A_trevor: 0.44,
  freshp4B_trevor: 0.69,
};

test("fixtures: all 22 traces load, each with voice and text", () => {
  assert.equal(Object.keys(TRACES).length, 22);
  assert.deepEqual(Object.keys(TRACES).sort(), Object.keys(IDEAL).sort());
  for (const t of Object.values(TRACES)) {
    assert.ok(["jared", "trevor", "jay"].includes(t.voice), t.name);
    assert.ok(t.text.length > 0, t.name);
    assert.ok(arrivalsOf(t).length >= 1, t.name);
  }
});

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

test("estimateSpeechSeconds: 81 chars → 3.63 s (0.56 + 81/26.4)", () => {
  assert.equal(estimateSpeechSeconds(81).toFixed(2), "3.63");
  assert.equal(estimateSpeechSeconds("x".repeat(81)).toFixed(2), "3.63");
});

test("observedSpeedScale: the median slope ignores one stall", () => {
  // Slopes 1, 1, 6 (a stall), 1 → median 1.
  const pts = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 8],
    [4, 9],
  ];
  assert.equal(observedSpeedScale(pts), 1);
  assert.equal(observedSpeedScale([[0, 0]]), null);
});

test("startAt: null when cold with a single arrival, −Infinity when done", () => {
  const cold = {
    arrivals: [{ t: 0.4, s: 0.27 }],
    now: 0.4,
    done: false,
    chars: 81,
    scheduled: 0,
    underruns: 0,
    cal: calFor(createCalibration(), "chatterbox:jared"),
  };
  assert.equal(startAt(cold), null);
  assert.equal(startAt({ ...cold, done: true }), Number.NEGATIVE_INFINITY);
  // Warm: one arrival is enough to plan.
  const cal = createCalibration();
  cal.voices["chatterbox:jared"] = {
    c: 1,
    lenScale: 1,
    lenDev: 0.08,
    bias: 1,
  };
  const at = startAt({ ...cold, cal: calFor(cal, "chatterbox:jared") });
  assert.equal(typeof at, "number");
  assert.ok(at > 0.4 && Number.isFinite(at), `at ${at}`);
});

test('updateCalibration: "Sure." never updates calibration', () => {
  const cal = createCalibration();
  updateCalibration(
    cal,
    voiceKey("jared"),
    arrivalsOf(TRACES.live_short_jared),
    "Sure.".length,
  );
  assert.deepEqual(cal, createCalibration());
});

test("updateCalibration: a full sentence calibrates c, length and bias", () => {
  const cal = createCalibration();
  const t = TRACES.live1_jared;
  updateCalibration(cal, voiceKey("jared"), arrivalsOf(t), t.text.length, 5);
  const v = cal.voices[voiceKey("jared")];
  assert.ok(v.c > 0.5 && v.c < 2, `c ${v.c}`);
  assert.ok(v.lenScale > 0.5 && v.lenScale < 1.5, `lenScale ${v.lenScale}`);
  assert.equal(cal.lastC, v.c);
  assert.equal(v.updatedAt, 5);
});

/** Map-backed Storage shim. */
function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

test("persistence: round-trip under buzz.tts.jb.v1, per voice", () => {
  const storage = memoryStorage();
  const cal = createCalibration();
  const t = TRACES.live1_jared;
  const now = 1_000_000;
  updateCalibration(cal, voiceKey("jared"), arrivalsOf(t), t.text.length, now);
  saveCalibration(cal, storage);
  assert.ok(storage.map.has("buzz.tts.jb.v1"));
  assert.equal(CALIBRATION_STORAGE_KEY, "buzz.tts.jb.v1");
  const loaded = loadCalibration(storage, now + 60_000);
  assert.deepEqual(loaded.voices, cal.voices);
  assert.equal(loaded.lastC, cal.lastC);
});

test("persistence: entries older than 7 days expire; other versions are ignored", () => {
  const storage = memoryStorage();
  const cal = createCalibration();
  const t = TRACES.live1_jared;
  const now = 1_000_000;
  updateCalibration(cal, voiceKey("jared"), arrivalsOf(t), t.text.length, now);
  saveCalibration(cal, storage);
  const day = 24 * 60 * 60 * 1000;
  assert.ok(loadCalibration(storage, now + 6 * day).voices[voiceKey("jared")]);
  const stale = loadCalibration(storage, now + 8 * day);
  assert.deepEqual(stale.voices, {});
  assert.equal(stale.lastC, null);
  storage.setItem("buzz.tts.jb.v1", JSON.stringify({ v: 2, voices: {} }));
  assert.deepEqual(loadCalibration(storage, now), createCalibration());
  storage.setItem("buzz.tts.jb.v1", "{not json");
  assert.deepEqual(loadCalibration(storage, now), createCalibration());
});

// ---------------------------------------------------------------------------
// Virtual clock: a discrete-event loop. The code under test runs until it
// is idle (setImmediate after its microtasks), then the earliest pending
// event fires and the clock jumps to it.
// ---------------------------------------------------------------------------

function virtualClock() {
  let now = 0;
  const events = [];
  const at = (when, fn) => {
    const event = { when, fn, dead: false, seq: events.length };
    events.push(event);
    return () => {
      event.dead = true;
    };
  };
  const timer = (ms, fn) => at(now + ms / 1000, fn);
  async function run(promise) {
    let finished = false;
    let failure = null;
    promise.then(
      () => {
        finished = true;
      },
      (err) => {
        finished = true;
        failure = err;
      },
    );
    for (let steps = 0; ; steps++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (finished) break;
      const live = events.filter((e) => !e.dead);
      if (live.length === 0) throw new Error("virtual clock deadlock");
      live.sort((a, b) => a.when - b.when || a.seq - b.seq);
      const next = live[0];
      next.dead = true;
      now = Math.max(now, next.when);
      next.fn();
      if (steps > 100_000) throw new Error("runaway");
    }
    if (failure) throw failure;
    return promise;
  }
  return {
    get now() {
      return now;
    },
    at,
    timer,
    run,
  };
}

/** Fake AudioContext on the virtual clock; records scheduled pieces. */
function fakeContext(clock, pieces, tag = () => 0) {
  return {
    get currentTime() {
      return clock.now;
    },
    destination: {},
    createBuffer: (_c, length) => ({ length, copyToChannel() {} }),
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      start(when) {
        pieces.push({
          when,
          dur: this.buffer.length / BRIDGE_SAMPLE_RATE,
          k: tag(),
        });
      },
      stop() {
        this.stopped = true;
      },
    }),
  };
}

/**
 * Issue one "request" at virtual time `requestAt` for `trace` on a serial
 * server that is free at `serverFree`. Returns the body, the headers time,
 * and the absolute done time.
 */
function serve(clock, trace, requestAt, serverFree) {
  const base = Math.max(requestAt, serverFree);
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  for (const a of trace.arr) {
    clock.at(base + a.t, () => {
      if (a.done) controller.close();
      else if (a.bytes > 0) controller.enqueue(new Uint8Array(a.bytes));
    });
  }
  const doneAt = base + trace.arr[trace.arr.length - 1].t;
  return { body, headersAt: base + trace.tHdr, doneAt };
}

/** Mid-sentence gaps among one sentence's pieces. */
function gapsOf(pieces) {
  const sorted = [...pieces].sort((a, b) => a.when - b.when);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].when - (sorted[i - 1].when + sorted[i - 1].dur);
    if (gap > 1e-3) gaps.push(gap);
  }
  return gaps;
}

/**
 * Replay a reply of sentences like agentSpeechPlayer does: request k+1 as
 * soon as k's headers are in (one-ahead prefetch), drain every body from
 * its headers with the REAL drainTimed, play each through the REAL
 * playBridgeResponse. Returns per-sentence {startDelay, gaps, audio}.
 */
async function replayReply(names, calibration) {
  const clock = virtualClock();
  const pieces = [];
  let k = 0;
  const ctx = fakeContext(clock, pieces, () => k);
  const traces = names.map((n) => TRACES[n]);
  const results = [];
  let serverFree = 0;
  const request = (i, at) => {
    const served = serve(clock, traces[i], at, serverFree);
    serverFree = served.doneAt;
    let drain = null;
    const headers = new Promise((resolve) => {
      clock.at(served.headersAt, () => {
        drain = drainTimed({ body: served.body }, ctx);
        resolve();
      });
    });
    return { headers, drain: () => drain, served };
  };
  const session = (async () => {
    let current = request(0, 0);
    for (let i = 0; i < traces.length; i++) {
      await current.headers;
      const next = i + 1 < traces.length ? request(i + 1, clock.now) : null;
      k = i;
      const trace = traces[i];
      await playBridgeResponse(current.drain(), ctx, {
        scheduleWake: clock.timer,
        scheduleSettle: clock.timer,
        jitter: {
          chars: trace.text.trim().length,
          voiceKey: voiceKey(trace.voice),
          calibration,
          storage: null,
        },
      });
      const mine = pieces.filter((p) => p.k === i);
      const firstArrival =
        current.served.doneAt - trace.arr.at(-1).t + trace.arr[0].t;
      results.push({
        name: trace.name,
        startDelay: Math.min(...mine.map((p) => p.when)) - firstArrival,
        gaps: gapsOf(mine),
        audio: mine.reduce((sum, p) => sum + p.dur, 0),
      });
      current = next;
    }
  })();
  await clock.run(session);
  return results;
}

// ---------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------

const fmtGaps = (g) =>
  g.length === 0 ? "0" : `${g.length}× max ${Math.max(...g).toFixed(2)}s`;

/**
 * Start-delay allowance over the oracle. r3_whole_jared is the exception:
 * THREE sentences in one request (14 s of audio), a shape the bridge route
 * no longer sends (`chunkBridgeText` = one sentence per request). The
 * architect's prototype with the shipped defaults starts it at 8.99 s
 * (ideal 5.06) — gapless, but 3.9 s late — so it is pinned at that, not
 * at +1.2, rather than tuning constants for a retired request shape.
 */
const ALLOWANCE = { r3_whole_jared: 4.0 };

for (const name of Object.keys(IDEAL).sort()) {
  const allowance = ALLOWANCE[name] ?? 1.2;
  test(`replay cold ${name}: ≤1 gap, start ≤ ideal + ${allowance} s`, async () => {
    const [r] = await replayReply([name], createCalibration());
    if (process.env.JB_REPLAY_LOG) {
      console.log(
        `REPLAY ${name} start=${r.startDelay.toFixed(2)} ideal=${IDEAL[name]} gaps=${fmtGaps(r.gaps)}`,
      );
    }
    const total = arrivalsOf(TRACES[name]).reduce((s, a) => s + a.s, 0);
    assert.ok(Math.abs(r.audio - total) < 1e-6, `audio ${r.audio} vs ${total}`);
    assert.ok(r.gaps.length <= 1, `gaps ${fmtGaps(r.gaps)}`);
    assert.ok(
      r.startDelay <= IDEAL[name] + allowance,
      `start ${r.startDelay.toFixed(2)} > ideal ${IDEAL[name]} + ${allowance}`,
    );
  });
}

const SESSIONS = {
  "H-A jared 3-sentence": [["r3_s1_jared", "r3_s2_jared", "r3_s3_jared"]],
  "H-B trevor 3-sentence": [["r3_s1_trevor", "r3_s2_trevor", "r3_s3_trevor"]],
  "F-1 fresh session": [
    ["freshp3A_jared", "freshp3B_jared"],
    ["freshp1A_trevor", "freshp1B_trevor"],
    ["freshp2A_jay", "freshp2B_jay"],
    ["freshp4A_trevor", "freshp4B_trevor"],
  ],
};

for (const [label, replies] of Object.entries(SESSIONS)) {
  test(`pipeline ${label}: zero mid-sentence gaps`, async () => {
    const calibration = createCalibration();
    const all = [];
    for (const reply of replies) {
      all.push(...(await replayReply(reply, calibration)));
    }
    if (process.env.JB_REPLAY_LOG) {
      for (const r of all) {
        console.log(
          `PIPE ${label} ${r.name} start=${r.startDelay.toFixed(2)} gaps=${fmtGaps(r.gaps)}`,
        );
      }
    }
    assert.equal(all.length, replies.flat().length);
    for (const r of all) {
      assert.ok(r.audio > 0.3, `${r.name} audio ${r.audio}`);
      assert.equal(r.gaps.length, 0, `${r.name}: gaps ${fmtGaps(r.gaps)}`);
    }
  });
}

/** Synthetic trace: `chunk`-second chunks at real-time factor `rtf`. */
function synthTrace(total, chunk, rtf, firstByte = 0.3) {
  const arr = [];
  let s = 0;
  const n0 = Math.min(chunk, total);
  while (s < total - 1e-9) {
    const n = Math.min(chunk, total - s);
    const e = s + n;
    arr.push({
      t: firstByte + (e - n0) * rtf,
      bytes: Math.round(n * BRIDGE_SAMPLE_RATE) * 2,
    });
    s = e;
  }
  arr.push({ t: arr.at(-1).t + 0.001, bytes: 0, done: true });
  return {
    name: "synth_healthy",
    voice: "jared",
    text: "Sure, I can take a look at that pull request this afternoon and leave comments before the standup.",
    tHdr: firstByte,
    arr,
  };
}

test("healthy GPU (rtf 0.3, 0.45 s chunks): starts ≤ 0.5 s cold and after a stale slow c = 1.1", async () => {
  TRACES.synth_healthy = synthTrace(4.5, 0.45, 0.3);
  try {
    const [cold] = await replayReply(["synth_healthy"], createCalibration());
    assert.ok(cold.startDelay <= 0.5, `cold ${cold.startDelay.toFixed(2)}`);
    assert.equal(cold.gaps.length, 0);
    const stale = createCalibration();
    stale.voices[voiceKey("jared")] = {
      c: 1.1,
      lenScale: 1,
      lenDev: 0.08,
      bias: 1,
    };
    stale.lastC = 1.1;
    for (let i = 0; i < 3; i++) {
      const [r] = await replayReply(["synth_healthy"], stale);
      assert.ok(
        r.startDelay <= 0.5,
        `after stale c: ${r.startDelay.toFixed(2)}`,
      );
      assert.equal(r.gaps.length, 0);
    }
  } finally {
    delete TRACES.synth_healthy;
  }
});

test("an interrupt while audio is held schedules nothing", async () => {
  const clock = virtualClock();
  const pieces = [];
  const ctx = fakeContext(clock, pieces);
  const served = serve(clock, TRACES.live1_jared, 0, 0);
  let stop = false;
  // Stop after the first arrival (cold, one arrival → policy waits).
  clock.at(TRACES.live1_jared.arr[0].t + 0.01, () => {
    stop = true;
  });
  const result = await clock.run(
    playBridgeResponse({ body: served.body }, ctx, {
      shouldStop: () => stop,
      scheduleWake: clock.timer,
      scheduleSettle: clock.timer,
      jitter: { chars: 108, voiceKey: "chatterbox:jared", storage: null },
    }),
  );
  assert.equal(pieces.length, 0, "held audio must never reach the clock");
  assert.equal(result.seconds, 0);
});

test("drainTimed: stamps each chunk at ARRIVAL, not at consumption", async () => {
  const clock = virtualClock();
  const served = serve(clock, TRACES.live1_jared, 0, 0);
  const drain = drainTimed(
    { body: served.body },
    {
      get currentTime() {
        return clock.now;
      },
    },
  );
  const stamps = [];
  const consume = (async () => {
    // Consume nothing until the whole stream is in (a prefetched body).
    await new Promise((resolve) => clock.at(served.doneAt + 1, resolve));
    for (let c = await drain.next(); c !== null; c = await drain.next()) {
      stamps.push(c.at);
    }
  })();
  await clock.run(consume);
  const expected = TRACES.live1_jared.arr
    .filter((a) => !a.done && a.bytes > 0)
    .map((a) => a.t);
  assert.equal(stamps.length, expected.length);
  for (const [i, t] of stamps.entries()) {
    assert.ok(
      Math.abs(t - expected[i]) < 1e-9,
      `chunk ${i}: ${t} vs ${expected[i]}`,
    );
  }
  // The oracle on this very trace: the stamps ARE its arrival times.
  assert.ok(
    Math.abs(
      oracleOffset(stamps.map((t) => ({ t, s: 0.45 }))) -
        oracleOffset(expected.map((t) => ({ t, s: 0.45 }))),
    ) < 1e-9,
  );
});

test("a completed stream updates AND saves the calibration; the log keeps the last 50", async () => {
  const storage = memoryStorage();
  const calibration = createCalibration();
  const trace = TRACES.live1_jared;
  const clock = virtualClock();
  const ctx = fakeContext(clock, []);
  const served = serve(clock, trace, 0, 0);
  await clock.run(
    playBridgeResponse({ body: served.body }, ctx, {
      scheduleWake: clock.timer,
      scheduleSettle: clock.timer,
      jitter: {
        chars: trace.text.length,
        voiceKey: "chatterbox:jared",
        calibration,
        storage,
      },
    }),
  );
  assert.ok(calibration.voices["chatterbox:jared"]?.c > 0, "calibrated");
  const saved = loadCalibration(storage);
  assert.deepEqual(saved.voices, calibration.voices, "saved to storage");
  const last = recentBridgeStreams().at(-1);
  assert.equal(last.voiceKey, "chatterbox:jared");
  assert.equal(last.chars, trace.text.length);
  assert.ok(
    Math.abs(last.idealDelay - 0.93) < 0.05,
    `ideal ${last.idealDelay}`,
  );

  for (let i = 0; i < 55; i++) {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(4800));
        c.close();
      },
    });
    await playBridgeResponse({ body }, fakeContext({ now: 0 }, []), {
      scheduleSettle: (_ms, fn) => {
        const t = setTimeout(fn, 0);
        return () => clearTimeout(t);
      },
      jitter: { chars: i },
    });
  }
  const log = recentBridgeStreams();
  assert.equal(log.length, 50);
  assert.equal(log.at(-1).chars, 54);
  assert.equal(log[0].chars, 5);
});

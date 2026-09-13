import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

// --- Fake platform: rAF clock + AudioContext graph ---------------------------

// The hook throttles to 50ms off the rAF timestamp, so each pumped frame is
// 50ms of synthetic time and consumes exactly one scripted analyser level.
const rafCallbacks = new Map();
let rafSeq = 0;
let rafNow = 0;

function pumpFrames(count) {
  for (let i = 0; i < count; i += 1) {
    rafNow += 50;
    const pending = [...rafCallbacks.values()];
    rafCallbacks.clear();
    for (const cb of pending) cb(rafNow);
  }
}

function rafPending() {
  return rafCallbacks.size;
}

const audioContexts = [];

class FakeAnalyser {
  constructor(ctx) {
    this.ctx = ctx;
    this.fftSize = 0;
    this.connectedTo = [];
    // Scripted RMS levels: constant-amplitude frames whose amplitude IS
    // the RMS the gate should see. One entry per analyser read.
    this.levels = [0];
  }
  connect(node) {
    this.connectedTo.push(node);
  }
  disconnect() {
    this.ctx.analyserDisconnects += 1;
  }
  getFloatTimeDomainData(buffer) {
    const level = this.levels.shift() ?? 0;
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = level;
  }
}

class FakeSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.connectedTo = [];
  }
  connect(node) {
    this.connectedTo.push(node);
  }
  disconnect() {
    this.ctx.sourceDisconnects += 1;
  }
}

class FakeAudioContext {
  constructor() {
    this.destination = { destination: true };
    this.closed = false;
    this.analyserDisconnects = 0;
    this.sourceDisconnects = 0;
    this.source = null;
    this.analyser = new FakeAnalyser(this);
    audioContexts.push(this);
  }
  createMediaElementSource(element) {
    this.element = element;
    this.source = new FakeSource(this);
    return this.source;
  }
  createAnalyser() {
    return this.analyser;
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  globalThis.requestAnimationFrame = (cb) => {
    rafSeq += 1;
    rafCallbacks.set(rafSeq, cb);
    return rafSeq;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafCallbacks.delete(id);
  };
  globalThis.AudioContext = FakeAudioContext;
});

after(() => {
  dom.window.close();
});

// --- Fakes & helpers ---------------------------------------------------------

const CONFIG = {
  onThreshold: 0.02,
  offThreshold: 0.012,
  attackMs: 100,
  holdMs: 200,
};

function makeClient() {
  const calls = [];
  return {
    calls,
    muteInputAudio() {
      calls.push("mute");
    },
    unmuteInputAudio() {
      calls.push("unmute");
    },
  };
}

function makeProps(overrides = {}) {
  return {
    enabled: true,
    micOn: true,
    audioElement: dom.window.document.createElement("audio"),
    client: makeClient(),
    config: CONFIG,
    ...overrides,
  };
}

async function mountHook(props) {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { useBargeDuck } = await import("./useBargeDuck.ts");
  const harness = renderHook((next) => useBargeDuck(next), {
    initialProps: props,
  });
  return {
    rerender: (overrides = {}) => {
      act(() => {
        harness.rerender({ ...props, ...overrides });
      });
    },
    pump: (frames) => {
      act(() => {
        pumpFrames(frames);
      });
    },
    get ducked() {
      return harness.result.current;
    },
    unmount: () => {
      act(() => {
        harness.unmount();
      });
      cleanup();
    },
  };
}

// --- Wiring behaviour --------------------------------------------------------

test("gate close calls muteInputAudio and the gate opening calls unmuteInputAudio", async () => {
  audioContexts.length = 0;
  const props = makeProps();
  const hook = await mountHook(props);
  const ctx = audioContexts.at(-1);

  assert.deepEqual(props.client.calls, [], "an open live mic makes no call");
  assert.equal(rafPending(), 1, "the sampling loop is armed while live");
  assert.equal(ctx.element, props.audioElement, "analysing the persona audio");
  assert.deepEqual(ctx.source.connectedTo, [ctx.analyser]);
  // The graph must reach the destination or playback dies in some webviews.
  assert.deepEqual(ctx.analyser.connectedTo, [ctx.destination]);

  // t=50 quiet; t=100..200 loud (100ms attack) -> duck at t=200.
  ctx.analyser.levels = [0.0005, 0.05, 0.05, 0.05];
  hook.pump(4);
  assert.equal(ctx.analyser.levels.length, 0, "frames actually sampled");
  assert.deepEqual(props.client.calls, ["mute"]);
  assert.equal(hook.ducked, true);

  // t=250..400 quiet (200ms hold) -> reopen at t=400.
  ctx.analyser.levels = [0.0005, 0.0005, 0.0005, 0.0005];
  hook.pump(4);
  assert.deepEqual(props.client.calls, ["mute", "unmute"]);
  assert.equal(hook.ducked, false);

  hook.unmount();
  assert.equal(ctx.closed, true, "AudioContext closed on teardown");
  assert.equal(ctx.sourceDisconnects, 1);
  assert.equal(ctx.analyserDisconnects, 1);
  assert.equal(rafPending(), 0, "no timer leaks past unmount");
});

test("manual mute is the floor: no unmute ever fires while micOn is false", async () => {
  audioContexts.length = 0;
  const props = makeProps({ micOn: false });
  const hook = await mountHook(props);
  const ctx = audioContexts.at(-1);

  // Live entry reconciles the fresh client to the manual mute.
  assert.deepEqual(props.client.calls, ["mute"]);

  // She speaks (gate closes) — already muted, no new call.
  ctx.analyser.levels = [0.0005, 0.05, 0.05, 0.05];
  hook.pump(4);
  assert.deepEqual(props.client.calls, ["mute"]);

  // She stops (gate opens) — the manual floor holds the mute.
  ctx.analyser.levels = [0.0005, 0.0005, 0.0005, 0.0005];
  hook.pump(4);
  assert.deepEqual(
    props.client.calls,
    ["mute"],
    "gate-open must NOT unmute a manually muted mic",
  );
  assert.equal(hook.ducked, false);

  hook.unmount();
});

test("unmuting mid-duck stays muted until the gate opens, then unmutes exactly once", async () => {
  audioContexts.length = 0;
  const props = makeProps();
  const hook = await mountHook(props);
  const ctx = audioContexts.at(-1);

  ctx.analyser.levels = [0.0005, 0.05, 0.05, 0.05];
  hook.pump(4);
  assert.deepEqual(props.client.calls, ["mute"]);

  // User mutes mid-duck: no redundant call.
  hook.rerender({ micOn: false });
  assert.deepEqual(props.client.calls, ["mute"]);
  // ...and un-mutes again while still ducked: still no unmute.
  hook.rerender({ micOn: true });
  assert.deepEqual(
    props.client.calls,
    ["mute"],
    "unmute must not land while the gate is still closed",
  );

  ctx.analyser.levels = [0.0005, 0.0005, 0.0005, 0.0005];
  hook.pump(4);
  assert.deepEqual(props.client.calls, ["mute", "unmute"]);
  assert.equal(hook.ducked, false);

  hook.unmount();
});

test("no_client_calls_when_not_live", async () => {
  audioContexts.length = 0;
  const props = makeProps({ enabled: false });
  const hook = await mountHook(props);

  assert.equal(audioContexts.length, 0, "no AudioContext while not live");
  assert.equal(rafPending(), 0, "no sampling loop while not live");

  // Time passes and the mic toggles; nothing is driven.
  pumpFrames(12);
  hook.rerender({ micOn: false });

  assert.deepEqual(
    props.client.calls,
    [],
    "no client calls of any kind while not live",
  );
  assert.equal(audioContexts.length, 0);
  assert.equal(hook.ducked, false);

  hook.unmount();
});

test("turning the setting off mid-duck restores the mic, then re-arming ducks again", async () => {
  audioContexts.length = 0;
  const props = makeProps();
  const hook = await mountHook(props);
  const ctx = audioContexts.at(-1);

  // She speaks: gate closes, SDK muted.
  ctx.analyser.levels = [0.0005, 0.05, 0.05, 0.05];
  hook.pump(4);
  assert.deepEqual(props.client.calls, ["mute"]);
  assert.equal(hook.ducked, true);

  // Setting off mid-duck: the restore must issue the unmute HERE — the
  // stranded-mute bug this pins would clear the chip but leave the mic
  // SDK-muted with no loop left to reopen it.
  hook.rerender({ duckingEnabled: false });
  assert.deepEqual(
    props.client.calls,
    ["mute", "unmute"],
    "setting off mid-call must actively unmute the gate's mute",
  );
  assert.equal(hook.ducked, false);
  assert.equal(rafPending(), 0, "sampling loop stood down");
  assert.equal(ctx.closed, true, "analyser context torn down");

  // Time passes with the setting off: nothing further is driven or built.
  pumpFrames(10);
  assert.deepEqual(props.client.calls, ["mute", "unmute"]);
  assert.equal(audioContexts.length, 1, "no new analyser while off");

  // Setting back on mid-call: fresh analyser, gate re-arms and ducks.
  hook.rerender({ duckingEnabled: true });
  assert.equal(audioContexts.length, 2, "analyser rebuilt on re-enable");
  assert.equal(rafPending(), 1, "sampling loop re-armed");
  const ctx2 = audioContexts.at(-1);
  assert.notEqual(ctx2, ctx, "a fresh graph, not the torn-down one");
  ctx2.analyser.levels = [0.0005, 0.05, 0.05, 0.05];
  hook.pump(4);
  assert.deepEqual(props.client.calls, ["mute", "unmute", "mute"]);
  assert.equal(hook.ducked, true);

  hook.unmount();
});

test("setting off on an open mic builds nothing; the manual floor still works", async () => {
  audioContexts.length = 0;
  const props = makeProps({ duckingEnabled: false });
  const hook = await mountHook(props);

  assert.equal(audioContexts.length, 0, "no analyser for a disabled setting");
  assert.equal(rafPending(), 0, "no sampling loop for a disabled setting");
  assert.deepEqual(props.client.calls, [], "an open mic needs no SDK call");

  pumpFrames(6);

  // Ducking being off does NOT disable the manual floor: muting the mic
  // while live still converges the SDK to muted.
  hook.rerender({ micOn: false });
  assert.deepEqual(
    props.client.calls,
    ["mute"],
    "manual mute applies even with ducking off",
  );
  pumpFrames(6);
  assert.deepEqual(props.client.calls, ["mute"]);
  assert.equal(hook.ducked, false);

  hook.unmount();
});

test("manual mute survives the mid-call setting-off restore", async () => {
  audioContexts.length = 0;
  const props = makeProps({ micOn: false });
  const hook = await mountHook(props);
  const ctx = audioContexts.at(-1);

  assert.deepEqual(props.client.calls, ["mute"], "live entry honours manual mute");
  ctx.analyser.levels = [0.0005, 0.05, 0.05, 0.05];
  hook.pump(4);
  assert.deepEqual(props.client.calls, ["mute"], "gate adds nothing to a muted mic");

  // Turning the setting off converges to !micOn — still muted. An unmute
  // here would break the manual floor.
  hook.rerender({ duckingEnabled: false });
  assert.deepEqual(
    props.client.calls,
    ["mute"],
    "the restore must NOT unmute a manually muted mic",
  );

  hook.unmount();
});

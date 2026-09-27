import assert from "node:assert/strict";
import { test } from "node:test";

// The player behind useAgentSpeechPlayer, driven through its pure factory
// with the same stub shapes bridgeSpeech.test.mjs uses: a manual-clock
// AudioContext and a fetch that answers with raw PCM.

const spoken = [];
class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.volume = 1;
  }
}
globalThis.window = {
  speechSynthesis: {
    getVoices: () => [],
    cancel() {},
    speak(utterance) {
      spoken.push(utterance);
      queueMicrotask(() => utterance.onend?.());
    },
  },
  SpeechSynthesisUtterance: FakeUtterance,
};
globalThis.SpeechSynthesisUtterance = FakeUtterance;

const { createAgentSpeechPlayer } = await import("./lib/agentSpeechPlayer.ts");
const { BRIDGE_SAMPLE_RATE } = await import("../huddle/lib/bridgeSpeech.ts");

const AGENT = "a".repeat(64);

function manualContext() {
  const ctx = {
    now: 0,
    get currentTime() {
      return this.now;
    },
    destination: {},
    gainNode: null,
    starts: [],
    stops: 0,
    createGain() {
      ctx.gainNode = { gain: { value: 1 }, connect() {} };
      return ctx.gainNode;
    },
    createBuffer: (_ch, length) => ({ length, copyToChannel() {} }),
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        start(when) {
          ctx.starts.push(when);
        },
        stop() {
          ctx.stops += 1;
        },
      };
    },
    resume: () => Promise.resolve(),
  };
  return ctx;
}

function playerWith(ctx, fetchImpl) {
  return createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => undefined, // derived → pocket bridge route
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    fetchImpl,
  });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function pcmResponse(seconds) {
  return new Response(new Uint8Array(BRIDGE_SAMPLE_RATE * 2 * seconds), {
    status: 200,
  });
}

test("speak resolves only after the context clock passes the scheduled tail", async () => {
  const ctx = manualContext();
  const player = playerWith(ctx, () => Promise.resolve(pcmResponse(1)));
  let result = null;
  const pending = player.speak("Hello there.", AGENT).then((r) => {
    result = r;
  });
  // 1 s of audio scheduled from t=0.02; the clock has not moved.
  await tick(200);
  assert.ok(ctx.starts.length > 0, "the PCM was scheduled");
  assert.equal(result, null, "still pending while the clock sits at 0");
  ctx.now = 0.6;
  await tick(100);
  assert.equal(result, null, "still pending mid-audio (t=0.6 < tail 1.02)");
  ctx.now = 1.1;
  await tick(100);
  assert.equal(result, "spoken", "resolves once the tail has sounded");
  await pending;
  assert.equal(spoken.length, 0, "no local synth on the bridge path");
  player.dispose();
});

test("setMuted(true) sets the agent gain to 0 (and back to 1)", async () => {
  const ctx = manualContext();
  const player = playerWith(ctx, () => Promise.resolve(pcmResponse(1)));
  player.unlock(); // creates the context + gain inside the "gesture"
  assert.ok(ctx.gainNode, "a gain node was created with the context");
  assert.equal(ctx.gainNode.gain.value, 1);
  player.setMuted(true);
  assert.equal(ctx.gainNode.gain.value, 0);
  player.setMuted(false);
  assert.equal(ctx.gainNode.gain.value, 1);
  player.dispose();
});

test("interrupt() resolves a pending speak with 'stopped' and stops scheduled audio", async () => {
  const ctx = manualContext();
  const player = playerWith(ctx, () => Promise.resolve(pcmResponse(1)));
  const pending = player.speak("Hello there.", AGENT);
  await tick(100);
  assert.ok(ctx.starts.length > 0, "audio was scheduled before interrupt");
  player.interrupt();
  const result = await Promise.race([pending, tick(500).then(() => "hung")]);
  assert.equal(result, "stopped");
  assert.ok(ctx.stops > 0, "already-scheduled sources were stopped");
  player.dispose();
});

test("interrupt() during a hung bridge fetch resolves 'stopped' without waiting", async () => {
  const ctx = manualContext();
  const player = playerWith(ctx, () => new Promise(() => {}));
  const pending = player.speak("Hello there.", AGENT);
  await tick(20);
  player.interrupt();
  const result = await Promise.race([pending, tick(300).then(() => "hung")]);
  assert.equal(result, "stopped");
  player.dispose();
});

test("statechange listeners hear the context state", async () => {
  const ctx = manualContext();
  const listeners = {};
  ctx.state = "running";
  ctx.addEventListener = (type, fn) => {
    listeners[type] = fn;
  };
  ctx.removeEventListener = () => {};
  const player = playerWith(ctx, () => Promise.resolve(pcmResponse(1)));
  const seen = [];
  const off = player.onContextStateChange((s) => seen.push(s));
  assert.equal(player.contextState(), null, "no context before unlock");
  player.unlock();
  assert.equal(player.contextState(), "running");
  ctx.state = "suspended";
  listeners.statechange();
  off();
  ctx.state = "running";
  listeners.statechange();
  assert.deepEqual(seen, ["suspended"]);
  player.dispose();
});

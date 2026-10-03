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

test("Fish selection reaches real player POST and records fish-bridge playback", async () => {
  const requests = [];
  const routes = [];
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => ({
      engine: "fish",
      key: "fish:0123456789abcdef0123456789abcdef",
    }),
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => wallClockContext(),
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return pcmResponse(0.1);
    },
    onRoute: (_key, route) => routes.push(route),
  });
  assert.equal(await player.speak("Hello there.", AGENT), "spoken");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].engine, "fish");
  assert.equal(requests[0].voice, "0123456789abcdef0123456789abcdef");
  assert.equal(routes[0].disposition, "fish-bridge");
  player.dispose();
});

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

// ── Prefetch-one-ahead (design §6.2, AC-W3) ────────────────────────────────

// Three sentences of ~150 chars each: chunkSpeakableText (200-char cap)
// yields exactly three chunks — asserted, so a chunker change cannot turn
// these tests vacuous.
const SENTENCE = (n) =>
  `Sentence ${n} is deliberately long so that the chunker keeps it as its own utterance, well past half of the two hundred character cap here.`;
const THREE_CHUNKS = [SENTENCE(1), SENTENCE(2), SENTENCE(3)].join(" ");

/** A context whose clock is WALL time — tail gating then behaves for real. */
function wallClockContext() {
  const t0 = Date.now();
  const ctx = {
    get currentTime() {
      return (Date.now() - t0) / 1000;
    },
    destination: {},
    sources: [],
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    },
    createBuffer: (_ch, length) => ({ length, copyToChannel() {} }),
    createBufferSource() {
      const src = {
        buffer: null,
        connect() {},
        start(when) {
          ctx.sources.push({
            when,
            dur: src.buffer.length / BRIDGE_SAMPLE_RATE,
          });
        },
        stop() {},
      };
      return src;
    },
    resume: () => Promise.resolve(),
  };
  return ctx;
}

test("the chunk fixture really is three chunks", async () => {
  const { chunkSpeakableText } = await import(
    "../huddle/lib/huddleAgentSpeech.ts"
  );
  assert.equal(chunkSpeakableText(THREE_CHUNKS).length, 3);
});

test("AC-W3: chunk 2 is fetched before chunk 1 finishes playing", async () => {
  const ctx = wallClockContext();
  const fetchAt = [];
  const spokenAt = [];
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => undefined,
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    fetchImpl: () => {
      fetchAt.push(Date.now());
      return Promise.resolve(pcmResponse(0.3));
    },
    onChunkSpoken: () => spokenAt.push(Date.now()),
  });
  const result = await player.speak(THREE_CHUNKS, AGENT);
  assert.equal(result, "spoken");
  assert.equal(fetchAt.length, 3, "one POST per chunk, no more");
  assert.equal(spokenAt.length, 3);
  assert.ok(
    fetchAt[1] < spokenAt[0],
    `fetch #2 (${fetchAt[1]}) must start before chunk #1 settles (${spokenAt[0]})`,
  );
  assert.ok(fetchAt[2] < spokenAt[1], "fetch #3 before chunk #2 settles");
  player.dispose();
});

test("AC-W3: a 250 ms bridge first-byte leaves < 100 ms between chunks", async () => {
  const ctx = wallClockContext();
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => undefined,
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    // Chatterbox-like latency: headers after 250 ms, then 0.4 s of audio.
    fetchImpl: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(pcmResponse(0.4)), 250),
      ),
  });
  const result = await player.speak(THREE_CHUNKS, AGENT);
  assert.equal(result, "spoken");
  const sources = [...ctx.sources].sort((a, b) => a.when - b.when);
  // 0.4 s per chunk in ≤0.25 s pieces → 2 pieces per chunk, 6 in all.
  assert.equal(sources.length, 6, "every chunk's audio was scheduled");
  let maxGap = 0;
  for (let i = 1; i < sources.length; i++) {
    const prevEnd = sources[i - 1].when + sources[i - 1].dur;
    maxGap = Math.max(maxGap, sources[i].when - prevEnd);
  }
  // Sequential fetching would leave ≥ 250 ms (the fetch latency) here.
  assert.ok(maxGap < 0.1, `inter-chunk gap ${maxGap.toFixed(3)} s`);
  player.dispose();
});

test("interrupt aborts the prefetched request as well as the current one", async () => {
  const ctx = manualContext();
  const inits = [];
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => undefined,
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    fetchImpl: (_url, init) => {
      inits.push(init);
      return Promise.resolve(pcmResponse(1));
    },
  });
  const pending = player.speak(THREE_CHUNKS, AGENT);
  await tick(100);
  // Clock frozen at 0: chunk 1 is still "playing" and chunk 2 is prefetched.
  assert.equal(inits.length, 2, "exactly one request held ahead");
  player.interrupt();
  assert.equal(await pending, "stopped");
  assert.ok(inits[1].signal?.aborted, "the prefetched request was aborted");
  player.dispose();
});

test("a failure mid-chunk aborts the prefetched request", async () => {
  const ctx = manualContext();
  const inits = [];
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => undefined,
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    fetchImpl: (_url, init) => {
      inits.push(init);
      if (inits.length === 1) {
        // Headers arrive (200) — so chunk 2 gets prefetched — then the
        // body stream dies while chunk 1 is being read.
        const body = new ReadableStream({
          pull(controller) {
            controller.error(new Error("bridge stream died"));
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }
      return Promise.resolve(pcmResponse(1));
    },
  });
  const result = await player.speak(THREE_CHUNKS, AGENT);
  assert.equal(result, "fallback", "the failure dropped to local speech");
  assert.equal(inits.length, 2, "chunk 2 had been prefetched before failing");
  assert.ok(
    inits[1].signal?.aborted,
    "the failure path must abort the prefetched request",
  );
  player.dispose();
});

test("the owner's 30183 assignment outranks the agent's own 30182 at speak time", async () => {
  const ctx = manualContext();
  const bodies = [];
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => ({ engine: "pocket", key: "pocket:anna" }),
    voiceAssignmentFor: (pk) =>
      pk === AGENT
        ? { engine: "chatterbox", key: "chatterbox:evie" }
        : undefined,
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    fetchImpl: (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(pcmResponse(0.1));
    },
  });
  const pending = player.speak("Hello there.", AGENT.toUpperCase());
  await tick(100);
  ctx.now = 5;
  assert.equal(await pending, "spoken");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].engine, "chatterbox");
  assert.equal(bodies[0].voice, "evie");
  player.dispose();
});

// ── Bridge chunking + timed drain (jitter buffer, 2026-09-29) ──────────────

const SHORT_SENTENCES =
  "The logs from last night show the problem clearly. The migration ran twice by mistake. We can rerun it safely tomorrow.";

test("the bridge route sends ONE sentence per request (local synth would pack them)", async () => {
  const { chunkSpeakableText } = await import(
    "../huddle/lib/huddleAgentSpeech.ts"
  );
  assert.equal(chunkSpeakableText(SHORT_SENTENCES).length, 1, "fixture guard");
  const ctx = wallClockContext();
  const texts = [];
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => undefined,
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    fetchImpl: (_url, init) => {
      texts.push(JSON.parse(init.body).text);
      return Promise.resolve(pcmResponse(0.1));
    },
  });
  assert.equal(await player.speak(SHORT_SENTENCES, AGENT), "spoken");
  assert.deepEqual(texts, [
    "The logs from last night show the problem clearly.",
    "The migration ran twice by mistake.",
    "We can rerun it safely tomorrow.",
  ]);
  player.dispose();
});

test("the PREFETCHED body is read from its headers on, while chunk 1 still plays", async () => {
  const ctx = wallClockContext();
  const firstPullAt = [];
  const spokenAt = [];
  let requests = 0;
  const player = createAgentSpeechPlayer({
    getVoices: () => [],
    voiceSelectionFor: () => undefined,
    ttsUrl: () => "https://web.test:6366/tts",
    createAudioContext: () => ctx,
    fetchImpl: () => {
      const index = requests++;
      let sent = false;
      // highWaterMark 0: the body is pulled ONLY when someone reads it.
      const body = new ReadableStream(
        {
          pull(controller) {
            if (firstPullAt[index] === undefined)
              firstPullAt[index] = Date.now();
            if (sent) {
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(new Uint8Array(BRIDGE_SAMPLE_RATE * 2 * 0.4));
          },
        },
        { highWaterMark: 0 },
      );
      return Promise.resolve(new Response(body, { status: 200 }));
    },
    onChunkSpoken: () => spokenAt.push(Date.now()),
  });
  assert.equal(await player.speak(THREE_CHUNKS, AGENT), "spoken");
  assert.equal(requests, 3);
  assert.ok(
    firstPullAt[1] < spokenAt[0],
    `body #2 first read at ${firstPullAt[1]} must precede chunk #1 settling at ${spokenAt[0]}`,
  );
  player.dispose();
});

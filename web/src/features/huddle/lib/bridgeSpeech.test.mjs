import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRIDGE_PIECE_SAMPLES,
  BRIDGE_SAMPLE_RATE,
  chunkToInt16Pieces,
  DERIVED_POCKET_PRESETS,
  derivedBridgeVoice,
  int16ToFloat32,
  playBridgeResponse,
  selectionToBridgeRequest,
  ttsBridgeUrl,
} from "./bridgeSpeech.ts";

test("ttsBridgeUrl builds from the serving hostname", () => {
  assert.equal(
    ttsBridgeUrl("crichton.tailb3d4b8.ts.net"),
    "https://crichton.tailb3d4b8.ts.net:6366/tts",
  );
});

test("selectionToBridgeRequest maps engines", () => {
  assert.deepEqual(selectionToBridgeRequest({ engine: "pocket", key: "pocket:azelma" }), {
    engine: "pocket",
    voice: "azelma",
  });
  assert.deepEqual(
    selectionToBridgeRequest({
      engine: "eleven",
      key: "eleven:T720RsqorTx4ZZWohrNN",
    }),
    { engine: "eleven", voice: "T720RsqorTx4ZZWohrNN" },
  );
  // Imported pocket keys are NOT bridge-runnable today — null, never a
  // bogus voice string.
  assert.equal(
    selectionToBridgeRequest({
      engine: "pocket",
      key: "pocket:imported:" + "a".repeat(64),
    }),
    null,
  );
  assert.equal(
    selectionToBridgeRequest({ engine: "local-synth", voiceURI: "Alex" }),
    null,
  );
});

test("chunkToInt16Pieces survives odd byte offsets and splits long chunks", () => {
  // An ODD byteOffset view over a byte buffer — the Int16Array constructor
  // would throw if framing didn't copy. Build one via subarray.
  const bytes = new Uint8Array(2 * BRIDGE_PIECE_SAMPLES + 3); // odd-ish total
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (i * 7) % 256;
  }
  const oddView = bytes.subarray(1); // byteOffset 1
  const pieces = chunkToInt16Pieces(oddView, BRIDGE_PIECE_SAMPLES);
  assert.ok(pieces.length >= 2, "long input splits into multiple pieces");
  for (const piece of pieces) {
    assert.ok(piece.length > 0 && piece.length <= BRIDGE_PIECE_SAMPLES);
    assert.equal(piece.byteOffset % 2, 0, "every piece is 2-byte aligned");
  }
  // Total samples: floor((bytes.length-1)/2) — the odd leading byte is
  // dropped, never misframed.
  const total = pieces.reduce((a, p) => a + p.length, 0);
  assert.equal(total, Math.floor((bytes.length - 1) / 2));
  // A tiny chunk yields exactly one piece.
  const one = chunkToInt16Pieces(new Uint8Array([0x01, 0x00, 0xff, 0xff]), BRIDGE_PIECE_SAMPLES);
  assert.equal(one.length, 1);
  assert.deepEqual(Array.from(one[0]), [1, -1]);
});

test("int16ToFloat32 maps to [-1, 1)", () => {
  const f = int16ToFloat32(Int16Array.from([0, 32767, -32768]));
  assert.deepEqual(Array.from(f), [0, 32767 / 32768, -1]);
});

test("playBridgeResponse schedules pieces and settles after the tail", async () => {
  // A fake context with a manually advanced clock.
  let now = 0;
  const scheduled = [];
  const ctx = {
    get currentTime() {
      return now;
    },
    destination: {},
    createBuffer: (_ch, length, rate) => ({
      rate,
      length,
      copyToChannel() {},
    }),
    createBufferSource: () => {
      const src = {
        buffer: null,
        connect() {},
        start(when) {
          scheduled.push(when);
          now = Math.max(now, when);
        },
      };
      return src;
    },
  };
  // One chunk of 1 second of audio, delivered in a single network chunk.
  const pcm = new Uint8Array(BRIDGE_SAMPLE_RATE * 2);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(pcm);
      controller.close();
    },
  });
  const settleCalls = [];
  const result = await playBridgeResponse(
    { body },
    ctx,
    {
      scheduleSettle: (delayMs, fn) => {
        settleCalls.push(delayMs);
        const t = setTimeout(fn, Math.min(delayMs, 50));
        return () => clearTimeout(t);
      },
    },
  );
  assert.equal(result.seconds, 1);
  assert.equal(scheduled.length, Math.ceil(BRIDGE_SAMPLE_RATE / BRIDGE_PIECE_SAMPLES));
  // The settle timer was armed for the remaining schedule (plus slack) —
  // zero remaining here because start() advanced `now` past the queue.
  assert.equal(settleCalls.length, 1);
  assert.ok(settleCalls[0] >= 30);
});

test("playBridgeResponse stops when shouldStop signals", async () => {
  let now = 0;
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
        now = Math.max(now, when);
      },
    }),
  };
  let stopped = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4800)); // 0.1 s
      // Never close on its own — the stop path must cancel. The interval
      // clears itself once stopped so the test process can exit.
      const tick = setInterval(() => {
        if (stopped) {
          clearInterval(tick);
          controller.close();
        }
      }, 5);
    },
  });
  const pending = playBridgeResponse({ body }, ctx, {
    shouldStop: () => stopped,
    scheduleSettle: (delayMs, fn) => {
      setTimeout(fn, delayMs);
      return () => {};
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  stopped = true;
  const result = await pending;
  assert.ok(result.seconds >= 0);
});

test("derivedBridgeVoice is deterministic, from presets, never eve", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    // Synthetic pubkeys: hex-ish strings of varying content.
    const pk = (i.toString(16).padStart(2, "0") + "abcdef0123456789").repeat(2);
    const req = derivedBridgeVoice(pk);
    assert.equal(req.engine, "pocket");
    assert.ok(DERIVED_POCKET_PRESETS.includes(req.voice));
    assert.notEqual(req.voice, "eve");
    seen.add(req.voice);
    // Determinism: same key, same voice.
    assert.deepEqual(derivedBridgeVoice(pk), req);
  }
  // The draw actually spreads (a 1-of-11 draw over 50 keys would be broken).
  assert.ok(seen.size >= 4, `expected spread, got ${[...seen].join(",")}`);
});

test("DERIVED_POCKET_PRESETS equals the hardcoded 11-slug list (drift guard)", () => {
  // MUTATION GATE (voice-picker-v2 §4 AC3): rename a slug in
  // DERIVED_POCKET_PRESETS and THIS test fails by name. The list is
  // hardcoded, never derived from the constant it pins — and it must stay
  // the 11 publishable presets of crates/buzz-voice/src/bundled.rs
  // (eve excluded), matching the /voices/pocket roster the bridge serves
  // and the voicecheck gate asserts.
  assert.deepEqual([...DERIVED_POCKET_PRESETS], [
    "anna",
    "vera",
    "fantine",
    "charles",
    "paul",
    "eponine",
    "azelma",
    "george",
    "mary",
    "jane",
    "michael",
  ]);
});

test("derivedBridgeVoice differentiates co-speakers", () => {
  const a = derivedBridgeVoice("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
  const b = derivedBridgeVoice("bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222");
  // Not required to differ (11 presets, 2 draws can collide) — but these
  // two fixture keys must land apart, pinning that the hash sees the key.
  assert.notEqual(a.voice, b.voice);
});

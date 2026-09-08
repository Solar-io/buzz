import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bridgeErrorMessage,
  parseBridgeEvent,
  PcmBatcher,
  sttBridgeUrl,
} from "./sttBridge.ts";

/*
 * Every expected byte/value below is HAND-COMPUTED from the bridge contract
 * (PCM16 little-endian, 16 kHz mono, one batch per 100 ms = 1600 samples =
 * 3200 bytes) and the box-average resampler definition — never derived from
 * the implementation's own constants, so a change to either must fail here
 * instead of quietly rescaling the assertions along with it.
 *
 * Reference arithmetic (48 kHz → 16 kHz, integer ratio 3):
 *   output[k] = (in[3k] + in[3k+1] + in[3k+2]) / 3
 *   int16     = round(clamp(output, -1, 1) * 32767)
 * e.g. [0.5, 0.25, -0.25] → 0.5/3 = 0.1666… → round(5461.16…) = 5461.
 *
 * 44.1 kHz → 16 kHz is the non-integer case (ratio 441/160): one output
 * sample covers 441/160 input samples, so the group average weights each
 * input sample by its fractional coverage. For [0.25, 0.5, 0.75]:
 *   (160*0.25 + 160*0.5 + 121*0.75) / 441 = 0.477891… → round(15658.9…) = 15659.
 */

function int16At(buffer, sampleIndex) {
  return new DataView(buffer).getInt16(sampleIndex * 2, true);
}

function allInt16(buffer) {
  const view = new DataView(buffer);
  return Array.from({ length: view.byteLength / 2 }, (_, i) =>
    view.getInt16(i * 2, true),
  );
}

test("sttBridgeUrl builds the wss URL from the serving hostname", () => {
  assert.equal(
    sttBridgeUrl("crichton.tailb3d4b8.ts.net"),
    "wss://crichton.tailb3d4b8.ts.net:6361/stt",
  );
  assert.equal(sttBridgeUrl("localhost"), "wss://localhost:6361/stt");
});

test("a 48 kHz frame downsamples by averaging each 3-sample group", () => {
  const batcher = new PcmBatcher();
  const frame = new Float32Array([0.5, 0.25, -0.25]);
  assert.equal(
    batcher.push(frame, 48_000),
    null,
    "one sample is under a batch",
  );
  const rest = batcher.flush();
  assert.ok(rest, "flush returns the sub-batch remainder");
  assert.equal(rest.byteLength, 2);
  assert.equal(int16At(rest, 0), 5461);
});

test("out-of-range samples clamp to the Int16 range before conversion", () => {
  const hot = new PcmBatcher();
  hot.push(new Float32Array([2, 2, 2]), 48_000);
  assert.equal(int16At(hot.flush(), 0), 32767);

  const cold = new PcmBatcher();
  cold.push(new Float32Array([-2, -2, -2]), 48_000);
  assert.equal(int16At(cold.flush(), 0), -32767);
});

test("exactly 100 ms of 48 kHz silence emits one all-zero 3200-byte batch", () => {
  const batcher = new PcmBatcher();
  const batch = batcher.push(new Float32Array(4800), 48_000);
  assert.ok(batch, "4800 samples @ 48 kHz is exactly one batch");
  assert.equal(batch.byteLength, 3200);
  assert.ok(
    new Uint8Array(batch).every((byte) => byte === 0),
    "zero samples in must be zero bytes out",
  );
  assert.equal(batcher.flush(), null, "nothing remains after the batch");
});

test("99 ms at 48 kHz does not batch; flush returns the 3168-byte remainder", () => {
  const batcher = new PcmBatcher();
  assert.equal(
    batcher.push(new Float32Array(4752).fill(0.25), 48_000),
    null,
    "1584 samples is under the 1600-sample batch",
  );
  const rest = batcher.flush();
  assert.equal(rest.byteLength, 3168);
  assert.equal(int16At(rest, 0), 8192, "0.25 → round(0.25 × 32767) = 8192");
  assert.equal(int16At(rest, 1583), 8192);
  assert.equal(batcher.flush(), null, "flush drains completely");
});

test("a batch keeps only its first 1600 samples; the rest wait behind it", () => {
  const batcher = new PcmBatcher();
  // 4803 samples = 1601 output samples: one full batch plus a 1-sample tail.
  const batch = batcher.push(new Float32Array(4803).fill(0.25), 48_000);
  assert.equal(batch.byteLength, 3200);
  assert.equal(int16At(batch, 0), 8192);
  assert.equal(int16At(batch, 1599), 8192);
  const tail = batcher.flush();
  assert.equal(tail.byteLength, 2);
  assert.equal(int16At(tail, 0), 8192);
  assert.equal(batcher.flush(), null);
});

test("16 kHz input passes through sample-for-sample with no averaging", () => {
  const batcher = new PcmBatcher();
  assert.equal(
    batcher.push(new Float32Array([0.25, -0.25, 0.5]), 16_000),
    null,
  );
  const rest = batcher.flush();
  assert.equal(rest.byteLength, 6);
  assert.equal(int16At(rest, 0), 8192);
  assert.equal(int16At(rest, 1), -8192);
  assert.equal(int16At(rest, 2), 16384);
});

test("exactly 1600 samples at 16 kHz is one full batch", () => {
  const batcher = new PcmBatcher();
  const batch = batcher.push(new Float32Array(1600).fill(0.5), 16_000);
  assert.equal(batch.byteLength, 3200);
  assert.deepEqual(allInt16(batch).slice(0, 3), [16384, 16384, 16384]);
  assert.equal(batcher.flush(), null);
});

test("a non-integer ratio (44.1 kHz) averages weighted fractional groups", () => {
  const batcher = new PcmBatcher();
  assert.equal(
    batcher.push(new Float32Array([0.25, 0.5, 0.75]), 44_100),
    null,
    "one output sample is under a batch",
  );
  const rest = batcher.flush();
  assert.equal(rest.byteLength, 2);
  // (160×0.25 + 160×0.5 + 121×0.75) / 441 → 0.477891… → 15659.
  assert.equal(int16At(rest, 0), 15659);
});

test("44.1 kHz DC input preserves level and the exact output sample count", () => {
  const batcher = new PcmBatcher();
  // 8820 samples @ 44.1 kHz = 200 ms = 3200 output samples: two batches.
  const first = batcher.push(new Float32Array(8820).fill(0.5), 44_100);
  assert.equal(first.byteLength, 3200);
  assert.deepEqual(allInt16(first).slice(0, 4), [16384, 16384, 16384, 16384]);
  const second = batcher.flush();
  assert.equal(second.byteLength, 3200);
  assert.ok(allInt16(second).every((v) => v === 16384));
  assert.equal(batcher.flush(), null);
});

test("empty frames are a no-op", () => {
  const batcher = new PcmBatcher();
  assert.equal(batcher.push(new Float32Array(0), 48_000), null);
  assert.equal(batcher.flush(), null);
});

test("parseBridgeEvent decodes every documented server event", () => {
  assert.deepEqual(
    parseBridgeEvent('{"type":"ready","model":"whisper-tiny"}'),
    {
      type: "ready",
      model: "whisper-tiny",
    },
  );
  assert.deepEqual(parseBridgeEvent('{"type":"partial","text":"hello wor"}'), {
    type: "partial",
    text: "hello wor",
  });
  assert.deepEqual(
    parseBridgeEvent('{"type":"final","text":"hello world","language":"en"}'),
    { type: "final", text: "hello world", language: "en" },
  );
  assert.deepEqual(parseBridgeEvent('{"type":"done"}'), { type: "done" });
  assert.deepEqual(
    parseBridgeEvent('{"type":"error","message":"model overloaded"}'),
    { type: "error", message: "model overloaded" },
  );
});

test("parseBridgeEvent rejects non-JSON and non-event payloads", () => {
  assert.equal(parseBridgeEvent("not json"), null);
  assert.equal(parseBridgeEvent("42"), null);
  assert.equal(parseBridgeEvent('"a string"'), null);
  assert.equal(parseBridgeEvent('{"type":"surprise"}'), null);
});

test("bridgeErrorMessage prefers the server's message", () => {
  assert.equal(
    bridgeErrorMessage({ type: "error", message: "model overloaded" }),
    "model overloaded",
  );
});

test("bridgeErrorMessage falls back when the message is missing or blank", () => {
  assert.equal(
    bridgeErrorMessage({ type: "error" }),
    "Speech recognition failed.",
  );
  assert.equal(
    bridgeErrorMessage({ type: "error", message: "   " }),
    "Speech recognition failed.",
  );
  assert.equal(bridgeErrorMessage(null), "Speech recognition failed.");
});

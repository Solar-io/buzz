import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUPLICATE_WINDOW,
  gateFinalTranscript,
  MIN_TRANSCRIPT_CHARS,
  nextVoiceStatus,
  normalizeTranscript,
} from "./voiceTranscript.ts";

test("the gating constants are pinned, hardcoded", () => {
  assert.equal(MIN_TRANSCRIPT_CHARS, 3);
  assert.equal(DUPLICATE_WINDOW, 3);
});

test("normalizeTranscript collapses whitespace runs and trims", () => {
  assert.equal(normalizeTranscript("  hello   world  "), "hello world");
  assert.equal(normalizeTranscript("line\nbreak\ttab"), "line break tab");
  assert.equal(normalizeTranscript("   "), "");
});

test("gateFinalTranscript publishes a clean final as its normalized text", () => {
  assert.deepEqual(gateFinalTranscript("  ship  it now ", []), {
    ok: true,
    text: "ship it now",
  });
});

test("gateFinalTranscript rejects blank and too-short finals", () => {
  assert.deepEqual(gateFinalTranscript("   ", []), {
    ok: false,
    reason: "blank",
  });
  // 2 chars is under the pinned minimum of 3; 3 chars passes.
  assert.deepEqual(gateFinalTranscript("ok", []), {
    ok: false,
    reason: "too_short",
  });
  assert.deepEqual(gateFinalTranscript("hey", []), { ok: true, text: "hey" });
});

test("gateFinalTranscript rejects a duplicate of a recent final", () => {
  assert.deepEqual(
    gateFinalTranscript("evie are you there", ["evie are you there"]),
    { ok: false, reason: "duplicate" },
  );
  // Normalization happens BEFORE the duplicate check, so differently-spaced
  // repeats of the same speech are still duplicates.
  assert.deepEqual(
    gateFinalTranscript("evie  are   you there", ["evie are you there"]),
    { ok: false, reason: "duplicate" },
  );
  // And a genuinely different phrase passes even with history present.
  assert.deepEqual(
    gateFinalTranscript("yes i can hear you", ["evie are you there"]),
    {
      ok: true,
      text: "yes i can hear you",
    },
  );
});

test("nextVoiceStatus walks the documented lifecycle", () => {
  assert.equal(nextVoiceStatus("idle", { type: "start" }), "starting");
  assert.equal(
    nextVoiceStatus("starting", { type: "audio_started" }),
    "listening",
  );
  assert.equal(nextVoiceStatus("listening", { type: "ended" }), "idle");
  assert.equal(nextVoiceStatus("listening", { type: "stop" }), "idle");
  // A retry after a fatal error is a fresh user toggle.
  assert.equal(nextVoiceStatus("error", { type: "start" }), "starting");
});

test("nextVoiceStatus leaves benign errors invisible and fatal ones as error", () => {
  assert.equal(
    nextVoiceStatus("listening", { type: "errored", code: "no-speech" }),
    "listening",
  );
  assert.equal(
    nextVoiceStatus("starting", { type: "errored", code: "aborted" }),
    "starting",
  );
  assert.equal(
    nextVoiceStatus("listening", { type: "errored", code: "not-allowed" }),
    "error",
  );
  assert.equal(
    nextVoiceStatus("starting", { type: "errored", code: "network" }),
    "error",
  );
});

test("nextVoiceStatus ignores late events from a superseded state", () => {
  // audio_started arriving after ended must not resurrect "listening".
  assert.equal(nextVoiceStatus("idle", { type: "audio_started" }), "idle");
  // start while already starting is a no-op.
  assert.equal(nextVoiceStatus("starting", { type: "start" }), "starting");
  assert.equal(nextVoiceStatus("listening", { type: "start" }), "listening");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUPLICATE_WINDOW,
  finalTranscriptsFromEvent,
  gateFinalTranscript,
  isBenignRecognitionError,
  latestInterimTranscript,
  MIN_TRANSCRIPT_CHARS,
  nextVoiceStatus,
  normalizeTranscript,
  recognitionErrorMessage,
  RECOGNITION_ERROR_MESSAGES,
} from "./voiceTranscript.ts";

/*
 * Fixtures are constructed from the DOCUMENTED shape of
 * SpeechRecognitionEvent (DOM spec / MDN): `resultIndex` plus a `results`
 * list whose entries expose `isFinal`, `length`, and index access to
 * alternatives whose first element carries `transcript`. They are
 * spec-derived, not captured from a live browser.
 */
function alternative(transcript) {
  return { transcript, confidence: 0.87 };
}

function result(isFinal, transcript) {
  const entry = { isFinal, length: 1, 0: alternative(transcript) };
  return entry;
}

function recognitionEvent(results, resultIndex = 0) {
  const list = { length: results.length };
  for (let i = 0; i < results.length; i += 1) {
    list[i] = results[i];
  }
  return { resultIndex, results: list };
}

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

test("finalTranscriptsFromEvent returns unseen finals with their indices", () => {
  const event = recognitionEvent([
    result(true, "first final"),
    result(false, "interim words"),
    result(true, "second final"),
  ]);
  assert.deepEqual(finalTranscriptsFromEvent(event, new Set()), [
    { index: 0, transcript: "first final" },
    { index: 2, transcript: "second final" },
  ]);
});

test("finalTranscriptsFromEvent skips indices already seen", () => {
  const event = recognitionEvent([
    result(true, "first final"),
    result(false, "new interim"),
  ]);
  // Chrome re-delivers the unchanged final prefix alongside a growing
  // interim; the seen set must suppress the repeat.
  assert.deepEqual(finalTranscriptsFromEvent(event, new Set([0])), []);
});

test("finalTranscriptsFromEvent walks the whole list, not just resultIndex", () => {
  const event = recognitionEvent(
    [result(true, "a final before the change"), result(true, "changed final")],
    1,
  );
  assert.deepEqual(finalTranscriptsFromEvent(event, new Set()), [
    { index: 0, transcript: "a final before the change" },
    { index: 1, transcript: "changed final" },
  ]);
});

test("finalTranscriptsFromEvent ignores empty results entries", () => {
  const empty = { isFinal: true, length: 0 };
  const event = recognitionEvent([empty, result(true, "real one")]);
  assert.deepEqual(finalTranscriptsFromEvent(event, new Set()), [
    { index: 1, transcript: "real one" },
  ]);
});

test("latestInterimTranscript returns the newest non-final transcript", () => {
  const event = recognitionEvent([
    result(true, "already final"),
    result(false, "an interim"),
    result(false, "the newest interim"),
  ]);
  assert.equal(latestInterimTranscript(event), "the newest interim");
});

test("latestInterimTranscript is empty when every result is final", () => {
  const event = recognitionEvent([result(true, "one"), result(true, "two")]);
  assert.equal(latestInterimTranscript(event), "");
});

test("only no-speech and aborted are benign recognition errors", () => {
  assert.equal(isBenignRecognitionError("no-speech"), true);
  assert.equal(isBenignRecognitionError("aborted"), true);
  assert.equal(isBenignRecognitionError("not-allowed"), false);
  assert.equal(isBenignRecognitionError("audio-capture"), false);
  assert.equal(isBenignRecognitionError("network"), false);
  assert.equal(isBenignRecognitionError("service-not-allowed"), false);
  assert.equal(isBenignRecognitionError("language-not-supported"), false);
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

test("every fatal recognition error has a human message", () => {
  for (const code of [
    "not-allowed",
    "audio-capture",
    "network",
    "service-not-allowed",
    "language-not-supported",
  ]) {
    assert.ok(RECOGNITION_ERROR_MESSAGES[code], `missing message for ${code}`);
  }
  // Unknown codes get a fallback that names the code, not an undefined hole.
  assert.equal(
    recognitionErrorMessage("something-new"),
    "Speech recognition failed (something-new).",
  );
  assert.equal(
    recognitionErrorMessage("not-allowed"),
    "Microphone access was denied — allow it in the browser and try again.",
  );
});

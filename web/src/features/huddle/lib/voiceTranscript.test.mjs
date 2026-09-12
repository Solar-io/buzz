import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUPLICATE_WINDOW,
  ECHO_OVERLAP_RATIO,
  ECHO_SUBSTRING_MIN_CHARS,
  ECHO_TAIL_MS,
  gateFinalTranscript,
  isEchoOfUtterances,
  markVoiceFinal,
  MIN_TRANSCRIPT_CHARS,
  msSinceLastUtterance,
  nextVoiceStatus,
  normalizeForEcho,
  normalizeTranscript,
  recordUtterance,
  shouldHoldFinal,
  utterancesForHold,
  UTTERANCE_MAX_ENTRIES,
  UTTERANCE_RETENTION_MS,
  VOICE_TURN_MARKER,
} from "./voiceTranscript.ts";

test("the gating constants are pinned, hardcoded", () => {
  assert.equal(MIN_TRANSCRIPT_CHARS, 3);
  assert.equal(DUPLICATE_WINDOW, 3);
});

test("the voice marker matches the desktop bridge's [video] shape", () => {
  // buzz-acp's voice_turn.rs detects exactly these two prefixes; the marker
  // must keep the trailing space or the harness will not see the turn.
  assert.equal(VOICE_TURN_MARKER, "[voice] ");
});

test("markVoiceFinal prefixes the gated text with the voice marker", () => {
  assert.equal(
    markVoiceFinal("evie are you there"),
    "[voice] evie are you there",
  );
});

test("markVoiceFinal prefixes the gated text with the voice marker", () => {
  assert.equal(
    markVoiceFinal("evie are you there"),
    "[voice] evie are you there",
  );
});

test("dedupe matches raw text — the marker is added only after gating", () => {
  // The hook pushes gate.text (raw) into the duplicate window and the echo
  // suppressor, NEVER the marked form; if the marker rode inside either,
  // replays would no longer dedupe and echo matching would never hit.
  const gate = gateFinalTranscript("evie are you there", []);
  assert.equal(gate.ok, true);
  const raw = gate.ok ? gate.text : "";
  const marked = markVoiceFinal(raw);
  assert.ok(marked.startsWith(VOICE_TURN_MARKER));
  assert.deepEqual(gateFinalTranscript(raw, [raw]), {
    ok: false,
    reason: "duplicate",
  });
});

test("gate → mark composes: the marker rides on the normalized text", () => {
  const gate = gateFinalTranscript("  what's  the weather ", []);
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(markVoiceFinal(gate.text), "[voice] what's the weather");
  }
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

// ---------------------------------------------------------------------------
// Echo suppression. Voice mode publishes STT finals as the viewer's
// messages, and the avatar's local speechSynthesis voice comes out of the
// speakers into the same mic — so the avatar's own words can come back as
// finals and publish as the viewer's, p-tagging the agent with its own text.
// Layer 1 (the temporal hold) is `shouldHoldFinal`; Layer 2 (the similarity
// gate) is `isEchoOfUtterances`. Both live here as pure logic; the hook
// wiring in useHuddleVoiceMode is code-read covered, as the WebSocket wiring
// already is.
// ---------------------------------------------------------------------------

test("the echo-suppression constants are pinned, hardcoded", () => {
  assert.equal(ECHO_TAIL_MS, 1500);
  assert.equal(ECHO_OVERLAP_RATIO, 0.6);
  assert.equal(ECHO_SUBSTRING_MIN_CHARS, 15);
  assert.equal(UTTERANCE_RETENTION_MS, 120_000);
  assert.equal(UTTERANCE_MAX_ENTRIES, 50);
});

test("normalizeForEcho lowercases, strips punctuation, and collapses whitespace", () => {
  assert.equal(
    normalizeForEcho("My sweep done, JUST been pottering around!"),
    "my sweep done just been pottering around",
  );
  // Punctuation is removed without leaving a gap: "Don't" → "dont".
  assert.equal(normalizeForEcho("  Don't\tstop.  "), "dont stop");
  assert.equal(normalizeForEcho("..."), "");
  assert.equal(normalizeForEcho(""), "");
});

test("a verbatim repeat of the avatar's utterance is an echo", () => {
  const utterance = "my sweep done, just been pottering around";
  assert.equal(
    isEchoOfUtterances("my sweep done, just been pottering around", [
      utterance,
    ]),
    true,
  );
});

test("a near-verbatim repeat with one garbled word is still an echo", () => {
  // "is" inserted, "around" heard as "round": 6 of 9 union words shared.
  assert.equal(
    isEchoOfUtterances("my sweep is done, just been pottering round", [
      "my sweep done, just been pottering around",
    ]),
    true,
  );
});

test("a real question spoken over the avatar's reply is not an echo", () => {
  assert.equal(
    isEchoOfUtterances("Did you sleep okay?", ["Good morning, I slept fine"]),
    false,
  );
});

test("a garbled short echo with disjoint tokens is not caught by Layer 2", () => {
  // Accepted miss: Layer 1's temporal hold is the catch-all for these.
  assert.equal(isEchoOfUtterances("You planet", ["New plan"]), false);
});

test("case and punctuation differences do not rescue an echo", () => {
  assert.equal(
    isEchoOfUtterances("MY SWEEP DONE, JUST BEEN POTTering AROUND.", [
      "my sweep done, just been pottering around",
    ]),
    true,
  );
});

test("token overlap exactly at 0.6 is an echo; just below is not", () => {
  // 3 shared words, union of 5 → exactly ECHO_OVERLAP_RATIO (>= holds).
  // Word order differs so no substring relation exists — this isolates the
  // ratio comparison.
  assert.equal(
    isEchoOfUtterances("alpha beta gamma", ["gamma beta alpha delta epsilon"]),
    true,
  );
  // Just above: 5 shared of a union of 8 = 0.625.
  assert.equal(
    isEchoOfUtterances("alpha beta gamma delta epsilon", [
      "alpha beta epsilon gamma delta zeta eta theta",
    ]),
    true,
  );
  // Just below: 4 shared of a union of 7 ≈ 0.571.
  assert.equal(
    isEchoOfUtterances("alpha beta gamma delta", [
      "alpha beta epsilon gamma delta zeta eta",
    ]),
    false,
  );
});

test("a final containing, or contained in, a long-enough utterance is an echo", () => {
  // Short final inside a 15-char normalized utterance ("sweep done just" =
  // exactly 15) — caught by the substring rule, not the ratio (1/3 ≈ 0.33).
  assert.equal(isEchoOfUtterances("sweep", ["Sweep done, just"]), true);
  // At 14 normalized chars the substring rule no longer applies and the
  // ratio (1/3) does not reach 0.6 — not an echo.
  assert.equal(isEchoOfUtterances("sweep", ["Sweep done, jus"]), false);
  // The other direction: a long final that contains the utterance verbatim,
  // with enough extra words to keep the ratio at 7/15 ≈ 0.47.
  assert.equal(
    isEchoOfUtterances(
      "so my sweep done just been pottering around and then we left the room quickly",
      ["my sweep done, just been pottering around"],
    ),
    true,
  );
});

test("empty finals or an empty utterance ring are never echoes", () => {
  assert.equal(isEchoOfUtterances("", ["anything at all"]), false);
  assert.equal(isEchoOfUtterances("anything at all", []), false);
  assert.equal(isEchoOfUtterances("anything", ["", "..."]), false);
});

test("shouldHoldFinal holds while speaking and inside the tail, releases past it", () => {
  // Speaking holds regardless of when the avatar last stopped.
  assert.equal(shouldHoldFinal(true, Number.POSITIVE_INFINITY), true);
  assert.equal(shouldHoldFinal(true, 0), true);
  // Inside the tail window (VAD + model latency lands the echo final here).
  assert.equal(shouldHoldFinal(false, 0), true);
  assert.equal(shouldHoldFinal(false, 1499), true);
  // Exactly at the tail is past it; beyond it certainly is.
  assert.equal(shouldHoldFinal(false, 1500), false);
  assert.equal(shouldHoldFinal(false, 60_000), false);
});

test("the clean path is unchanged: a final with no avatar speech publishes", () => {
  // No recent utterances and not speaking → nothing to hold, and Layer 2
  // (which only ever sees held finals) has nothing to match. This is the
  // pure half of the proof; the hook wiring is code-read covered.
  assert.equal(shouldHoldFinal(false, Number.POSITIVE_INFINITY), false);
  assert.equal(
    isEchoOfUtterances("anything spoken while she is silent", []),
    false,
  );
});

test("recordUtterance appends newest-last within the retention window", () => {
  assert.deepEqual(recordUtterance([], "hi", 100), [{ text: "hi", at: 100 }]);
  const two = recordUtterance([], "one", 1);
  const three = recordUtterance(recordUtterance(two, "two", 2), "three", 3);
  assert.deepEqual(three, [
    { text: "one", at: 1 },
    { text: "two", at: 2 },
    { text: "three", at: 3 },
  ]);
});

test("recordUtterance evicts utterances older than the retention window", () => {
  // Newest lands at 200_000 → cutoff 80_000: entries at 10_000 and 79_999
  // are outside (the latter by one ms), an entry at exactly 80_000 stays.
  const fresh = recordUtterance([], "fresh morning", 10_000);
  const nearlyStale = recordUtterance(fresh, "nearly stale", 79_999);
  assert.deepEqual(recordUtterance(nearlyStale, "newest", 200_000), [
    { text: "newest", at: 200_000 },
  ]);
  const withEdge = recordUtterance([], "exactly retention old", 80_000);
  assert.deepEqual(recordUtterance(withEdge, "newest", 200_000), [
    { text: "exactly retention old", at: 80_000 },
    { text: "newest", at: 200_000 },
  ]);
});

test("recordUtterance keeps at most 50 entries however fast speech arrives", () => {
  let ring = [];
  for (let i = 0; i < 60; i++) {
    ring = recordUtterance(ring, `u${i}`, i * 100);
  }
  assert.equal(ring.length, 50);
  assert.deepEqual(ring.map((entry) => entry.text).slice(0, 2), ["u10", "u11"]);
  assert.equal(ring[49].text, "u59");
});

test("a held final echoing sentence 1 of a 5-sentence reply is dropped", () => {
  // A long agent reply is many short sentences (the voice guidelines push
  // short conversational sentences), so the ring must remember them by
  // TIME, not by a small count: the echo final of sentence 1 lands within
  // the tail after sentence 1 ended, while sentences 2-5 are still being
  // spoken and holds keep accumulating behind them.
  const sentences = [
    "my sweep is done and the digest went out",
    "i also rebalanced the monitoring thresholds",
    "lord nikon cleared the alert backlog overnight",
    "the fleet directory picked up two new services",
    "and thunk now has the report pinned to five pm",
  ];
  let ring = [];
  sentences.forEach((text, index) => {
    ring = recordUtterance(ring, text, 1_000 + index * 1_000);
  });
  assert.equal(ring.length, 5);
  // The first held final arrives 400 ms after sentence 1 ended.
  const holdStartedAt = 1_400;
  const candidates = utterancesForHold(ring, holdStartedAt);
  assert.equal(candidates.length, 5);
  const texts = candidates.map((entry) => entry.text);
  assert.equal(isEchoOfUtterances(sentences[0], texts), true);
  // A barge-in mixed into the same sequence still publishes.
  assert.equal(
    isEchoOfUtterances("did you sleep okay last night", texts),
    false,
  );
});

test("utterancesForHold keeps what ended at or after the hold window start", () => {
  // Hold starts at 10_000 → cutoff 8_500: an utterance that settled
  // exactly at the cutoff is INCLUDED (an echo final can land a full tail
  // after its utterance ended); anything earlier had stopped sounding too
  // soon to echo into a final that arrived this late.
  const ring = [
    { text: "way before", at: 7_000 },
    { text: "just before", at: 8_499 },
    { text: "exactly at cutoff", at: 8_500 },
    { text: "after", at: 9_000 },
  ];
  const kept = utterancesForHold(ring, 10_000);
  assert.deepEqual(
    kept.map((entry) => entry.text),
    ["exactly at cutoff", "after"],
  );
});

test("msSinceLastUtterance reads the newest entry and is infinite when empty", () => {
  assert.equal(msSinceLastUtterance([], 1_000), Number.POSITIVE_INFINITY);
  assert.equal(msSinceLastUtterance([{ text: "a", at: 1_000 }], 2_500), 1_500);
  assert.equal(
    msSinceLastUtterance(
      [
        { text: "old", at: 1_000 },
        { text: "new", at: 2_000 },
      ],
      3_500,
    ),
    1_500,
  );
});

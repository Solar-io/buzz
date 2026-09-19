import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PREVIEW_SAMPLE_TEXT,
  VOICE_ENGINES,
  elevenVoiceOptions,
  engineLabel,
  engineVoiceOptions,
  pocketVoiceOptions,
  sameOption,
} from "./voicePickerOptions.ts";

const CATALOG_ROWS = [
  { content: { key: "pocket:azelma", displayName: "Azelma" } },
  { content: { key: "pocket:april", displayName: "April" } },
];
const ELEVEN_VOICES = [
  { id: "T720RsqorTx4ZZWohrNN", label: "Amara" },
  { id: "ZZ11aaBB", label: "Rook" },
  { id: "CC22ddEE", label: "Wren" },
];
const SOURCES = { catalogRows: CATALOG_ROWS, elevenVoices: ELEVEN_VOICES };

// ── Engines ────────────────────────────────────────────────────────────────

test("exactly two engines are offered, and on-device is not one of them", () => {
  assert.deepEqual([...VOICE_ENGINES], ["pocket", "eleven"]);
  assert.equal(engineLabel("pocket"), "Pocket");
  assert.equal(engineLabel("eleven"), "ElevenLabs");
});

// ── Pocket / ElevenLabs options ────────────────────────────────────────────

test("catalog rows become pocket options keyed by their row key", () => {
  assert.deepEqual(pocketVoiceOptions(CATALOG_ROWS), [
    { engine: "pocket", key: "pocket:azelma", label: "Azelma" },
    { engine: "pocket", key: "pocket:april", label: "April" },
  ]);
});

test("bridge voice rows become eleven options with the eleven: key prefix", () => {
  assert.deepEqual(elevenVoiceOptions(ELEVEN_VOICES.slice(0, 1)), [
    {
      engine: "eleven",
      key: "eleven:T720RsqorTx4ZZWohrNN",
      label: "Amara",
    },
  ]);
});

// ── THE ENGINE FILTER ──────────────────────────────────────────────────────

test("engineVoiceOptions returns the chosen engine's voices and ONLY those", () => {
  const pocket = engineVoiceOptions("pocket", SOURCES);
  // Count guard first: a filter that returned nothing would otherwise pass
  // every "no eleven rows here" assertion vacuously.
  assert.equal(pocket.length, 2, "both catalog rows");
  assert.ok(
    pocket.every((option) => option.engine === "pocket"),
    "no eleven row may appear under Pocket",
  );
  assert.deepEqual(
    pocket.map((option) => option.label),
    ["Azelma", "April"],
  );
  assert.ok(!pocket.some((option) => option.label === "Amara"));

  const eleven = engineVoiceOptions("eleven", SOURCES);
  assert.equal(eleven.length, 3, "all three bridge voices");
  assert.ok(
    eleven.every((option) => option.engine === "eleven"),
    "no pocket row may appear under ElevenLabs",
  );
  assert.deepEqual(
    eleven.map((option) => option.label),
    ["Amara", "Rook", "Wren"],
  );
  assert.ok(!eleven.some((option) => option.label === "Azelma"));

  // The two lists are disjoint — the flat combined list is gone.
  const pocketKeys = new Set(pocket.map((option) => option.key));
  assert.ok(eleven.every((option) => !pocketKeys.has(option.key)));
});

test("an engine with no rows yields an empty list, not the other engine's", () => {
  assert.deepEqual(
    engineVoiceOptions("eleven", {
      catalogRows: CATALOG_ROWS,
      elevenVoices: [],
    }),
    [],
    "a keyless bridge shows no voices, never the pocket ones",
  );
  assert.deepEqual(
    engineVoiceOptions("pocket", {
      catalogRows: [],
      elevenVoices: ELEVEN_VOICES,
    }),
    [],
  );
});

// ── Same-option comparison ─────────────────────────────────────────────────

test("sameOption distinguishes engine, target, and undefined", () => {
  const pocket = { engine: "pocket", key: "pocket:a", label: "A" };
  const pocketTwin = { engine: "pocket", key: "pocket:a" };
  const pocketOther = { engine: "pocket", key: "pocket:b", label: "B" };
  const eleven = { engine: "eleven", key: "eleven:a", label: "A" };
  assert.ok(sameOption(pocket, pocketTwin));
  assert.ok(!sameOption(pocket, pocketOther));
  assert.ok(!sameOption(pocket, eleven), "same key, different engine");
  assert.ok(!sameOption(pocket, undefined));
  assert.ok(!sameOption(undefined, eleven));
});

test("a stored on-device selection matches no offered row", () => {
  // The dropped engine: nothing in a picker can be it, so the comparison
  // must never light a row up as "Selected".
  const stored = { engine: "local-synth", voiceURI: "uri:samantha" };
  for (const option of [
    ...engineVoiceOptions("pocket", SOURCES),
    ...engineVoiceOptions("eleven", SOURCES),
  ]) {
    assert.ok(!sameOption(option, stored), `${option.key} must not match`);
  }
  assert.ok(!sameOption(stored, stored), "not even against itself");
});

// ── Preview text ───────────────────────────────────────────────────────────

test("every Preview speaks the same sample line", () => {
  assert.equal(PREVIEW_SAMPLE_TEXT, "Hi, this is my agent voice.");
});

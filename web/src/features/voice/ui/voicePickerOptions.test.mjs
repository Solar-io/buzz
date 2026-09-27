import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILTER_THRESHOLD,
  PREVIEW_SAMPLE_TEXT,
  VOICE_ENGINES,
  chatterboxVoiceOptions,
  elevenVoiceOptions,
  engineLabel,
  engineVoiceOptions,
  filterVoiceOptions,
  initialEngine,
  sameOption,
} from "./voicePickerOptions.ts";
import { parseChatterboxRoster } from "../lib/chatterboxRoster.ts";

// Roster fixture in the bridge's real wire shape (GET /voices/chatterbox,
// captured 2026-09-27): reserved voices carry NO reservedFor pubkey.
const ROSTER = parseChatterboxRoster({
  revision: 2,
  voices: [
    {
      key: "chatterbox:anna",
      slug: "anna",
      label: "Anna",
      gender: "female",
      style: "VCTK reader",
      reserved: false,
    },
    {
      key: "chatterbox:theo",
      slug: "theo",
      label: "Theo",
      gender: "male",
      style: "neutral",
      reserved: false,
    },
    {
      key: "chatterbox:eve",
      slug: "eve",
      label: "Eve",
      gender: "female",
      style: "alias target only",
      reserved: true,
    },
    {
      key: "chatterbox:evie",
      slug: "evie",
      label: "Evie",
      gender: "female",
      style: "bright, conversational",
      reserved: true,
    },
    { key: "chatterbox:Bad", label: "dropped: invalid key" },
  ],
});
const ELEVEN_VOICES = [
  { id: "T720RsqorTx4ZZWohrNN", label: "Amara" },
  { id: "ZZ11aaBB", label: "Rook" },
  { id: "CC22ddEE", label: "Wren" },
];
const SOURCES = { chatterboxVoices: ROSTER, elevenVoices: ELEVEN_VOICES };
const EVIE = { pubkey: "e".repeat(64), name: "Evie" };
const RICHARD = { pubkey: "f".repeat(64), name: "Richard Hendricks" };

// ── Engines ────────────────────────────────────────────────────────────────

test("Chatterbox replaces Pocket: exactly Chatterbox then ElevenLabs", () => {
  assert.deepEqual([...VOICE_ENGINES], ["chatterbox", "eleven"]);
  assert.equal(engineLabel("chatterbox"), "Chatterbox");
  assert.equal(engineLabel("eleven"), "ElevenLabs");
});

test("the picker opens on ElevenLabs only for an eleven row, else Chatterbox", () => {
  assert.equal(initialEngine(undefined), "chatterbox");
  assert.equal(initialEngine({ engine: "pocket" }), "chatterbox");
  assert.equal(initialEngine({ engine: "chatterbox" }), "chatterbox");
  assert.equal(initialEngine({ engine: "eleven" }), "eleven");
});

// ── Roster parse ───────────────────────────────────────────────────────────

test("the roster parse drops rows whose key fails the relay grammar", () => {
  assert.equal(ROSTER.length, 4, "4 valid rows; the uppercase key is dropped");
  assert.ok(!ROSTER.some((voice) => voice.key === "chatterbox:Bad"));
});

// ── Chatterbox options + the reserved-voice policy ─────────────────────────

test("self mode hides every reserved voice (eve AND evie)", () => {
  const options = chatterboxVoiceOptions(ROSTER, null);
  assert.deepEqual(
    options.map((option) => option.key),
    ["chatterbox:anna", "chatterbox:theo"],
  );
  assert.deepEqual(options[0], {
    engine: "chatterbox",
    key: "chatterbox:anna",
    label: "Anna",
    detail: "female · VCTK reader",
  });
});

test("Evie's voice is offered ONLY when the target is the Evie agent", () => {
  const forEvie = chatterboxVoiceOptions(ROSTER, EVIE).map((o) => o.key);
  assert.ok(forEvie.includes("chatterbox:evie"), "offered on Evie's row");
  assert.ok(!forEvie.includes("chatterbox:eve"), "eve has no agent of its own");
  assert.equal(forEvie.length, 3);
  const forRichard = chatterboxVoiceOptions(ROSTER, RICHARD).map((o) => o.key);
  assert.ok(!forRichard.includes("chatterbox:evie"), "never on anyone else");
  assert.equal(forRichard.length, 2);
});

test("a roster reservedFor pubkey is authoritative over the name match", () => {
  const [pinned] = parseChatterboxRoster({
    voices: [
      {
        key: "chatterbox:evie",
        label: "Evie",
        reserved: true,
        reservedFor: EVIE.pubkey.toUpperCase(),
      },
    ],
  });
  // Same name, different key: refused. Different name, right key: offered.
  assert.equal(
    chatterboxVoiceOptions([pinned], { pubkey: "a".repeat(64), name: "Evie" })
      .length,
    0,
  );
  assert.equal(
    chatterboxVoiceOptions([pinned], { pubkey: EVIE.pubkey, name: "Other" })
      .length,
    1,
  );
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
  const chatterbox = engineVoiceOptions("chatterbox", SOURCES);
  assert.equal(chatterbox.length, 2, "the two unreserved roster rows");
  assert.ok(chatterbox.every((option) => option.engine === "chatterbox"));
  const eleven = engineVoiceOptions("eleven", SOURCES);
  assert.equal(eleven.length, 3, "all three bridge voices");
  assert.ok(eleven.every((option) => option.engine === "eleven"));
  const keys = new Set(chatterbox.map((option) => option.key));
  assert.ok(eleven.every((option) => !keys.has(option.key)));
});

test("engineVoiceOptions threads the assign target to the reserved policy", () => {
  const keys = engineVoiceOptions("chatterbox", {
    ...SOURCES,
    target: EVIE,
  }).map((option) => option.key);
  assert.ok(keys.includes("chatterbox:evie"));
});

test("an engine with no rows yields an empty list, not the other engine's", () => {
  assert.deepEqual(
    engineVoiceOptions("eleven", {
      chatterboxVoices: ROSTER,
      elevenVoices: [],
    }),
    [],
  );
  assert.deepEqual(
    engineVoiceOptions("chatterbox", {
      chatterboxVoices: [],
      elevenVoices: ELEVEN_VOICES,
    }),
    [],
  );
});

test("the filter matches label and detail, case-insensitively", () => {
  const options = chatterboxVoiceOptions(ROSTER, EVIE);
  assert.deepEqual(
    filterVoiceOptions(options, "MALE").map((o) => o.key),
    // "female" contains "male": every row with a gender matches.
    ["chatterbox:anna", "chatterbox:theo", "chatterbox:evie"],
  );
  assert.deepEqual(
    filterVoiceOptions(options, "neutral").map((o) => o.key),
    ["chatterbox:theo"],
  );
  assert.equal(filterVoiceOptions(options, "  ").length, 3);
  assert.equal(FILTER_THRESHOLD, 12);
});

// ── Same-option comparison ─────────────────────────────────────────────────

test("sameOption distinguishes engine, target, and undefined", () => {
  const cb = { engine: "chatterbox", key: "chatterbox:a", label: "A" };
  const cbTwin = { engine: "chatterbox", key: "chatterbox:a" };
  const cbOther = { engine: "chatterbox", key: "chatterbox:b" };
  const eleven = { engine: "eleven", key: "chatterbox:a", label: "A" };
  assert.ok(sameOption(cb, cbTwin));
  assert.ok(!sameOption(cb, cbOther));
  assert.ok(!sameOption(cb, eleven), "same key, different engine");
  assert.ok(!sameOption(cb, undefined));
  assert.ok(!sameOption(undefined, eleven));
});

test("a stored on-device selection matches no offered row", () => {
  const stored = { engine: "local-synth", voiceURI: "uri:samantha" };
  const all = [
    ...engineVoiceOptions("chatterbox", SOURCES),
    ...engineVoiceOptions("eleven", SOURCES),
  ];
  assert.equal(all.length, 5);
  for (const option of all) {
    assert.ok(!sameOption(option, stored), `${option.key} must not match`);
  }
  assert.ok(!sameOption(stored, stored), "not even against itself");
});

// ── Preview text ───────────────────────────────────────────────────────────

test("every Preview speaks the same sample line", () => {
  assert.equal(PREVIEW_SAMPLE_TEXT, "Hi, this is my agent voice.");
});

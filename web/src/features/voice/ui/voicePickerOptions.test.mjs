import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENGLISH_ONLY,
  PREVIEW_SAMPLE_TEXT,
  localVoiceOptions,
  pocketVoiceOptions,
  sameOption,
  speakPreview,
} from "./voicePickerOptions.ts";

const FAKE_VOICES = [
  { name: "Zulu", lang: "en-AU", voiceURI: "uri:zulu", localService: true },
  { name: "Aaron", lang: "en-US", voiceURI: "uri:aaron", localService: true },
  { name: "Amelie", lang: "fr-CA", voiceURI: "uri:amelie", localService: true },
  { name: "Slovenian", lang: "sl-SI", voiceURI: "uri:sl", localService: true },
  {
    name: "Samantha",
    lang: "en-US",
    voiceURI: "uri:samantha",
    localService: false,
  },
];

// ── English filter (the ruled v1 invariant) ────────────────────────────────

test("picker surfaces only English voices — the ruled v1 invariant", () => {
  assert.equal(ENGLISH_ONLY, true);
  const options = localVoiceOptions(FAKE_VOICES);
  const names = options.map((option) => option.label);
  assert.deepEqual(names, ["Aaron", "Samantha", "Zulu"]);
  for (const option of options) {
    assert.equal(option.engine, "local-synth");
  }
});

test("the English filter matches on lang prefix, case-insensitively", () => {
  const odd = [{ name: "Odd", lang: "EN-gb", voiceURI: "uri:odd" }];
  assert.deepEqual(
    localVoiceOptions(odd).map((option) => option.label),
    ["Odd"],
  );
});

// ── Pocket options ─────────────────────────────────────────────────────────

test("catalog rows become pocket options keyed by their row key", () => {
  const rows = [
    { content: { key: "pocket:azelma", displayName: "Azelma" } },
    { content: { key: "pocket:april", displayName: "April" } },
  ];
  assert.deepEqual(pocketVoiceOptions(rows), [
    { engine: "pocket", key: "pocket:azelma", label: "Azelma" },
    { engine: "pocket", key: "pocket:april", label: "April" },
  ]);
});

// ── Same-option comparison ─────────────────────────────────────────────────

test("sameOption distinguishes engine, target, and undefined", () => {
  const local = { engine: "local-synth", voiceURI: "uri:a", label: "A" };
  const localTwin = { engine: "local-synth", voiceURI: "uri:a", label: "A" };
  const localOther = { engine: "local-synth", voiceURI: "uri:b", label: "B" };
  const pocket = { engine: "pocket", key: "pocket:a", label: "A" };
  assert.ok(sameOption(local, localTwin));
  assert.ok(!sameOption(local, localOther));
  assert.ok(!sameOption(local, pocket));
  assert.ok(!sameOption(local, undefined));
  assert.ok(!sameOption(undefined, pocket));
});

// ── Preview ────────────────────────────────────────────────────────────────

test("speakPreview speaks the sample line through local-synth with the chosen URI", () => {
  const calls = [];
  const synth = {
    cancel: () => calls.push("cancel"),
    speak: (utterance) => calls.push(utterance),
  };
  const option = {
    engine: "local-synth",
    voiceURI: "uri:aaron",
    label: "Aaron",
  };
  speakPreview(option, synth);
  assert.deepEqual(calls, [
    "cancel",
    { text: PREVIEW_SAMPLE_TEXT, voiceURI: "uri:aaron", lang: "en" },
  ]);
});

test("speakPreview cancels but is SILENT for pocket rows — the proxy leg is a stub", () => {
  const calls = [];
  const synth = {
    cancel: () => calls.push("cancel"),
    speak: (utterance) => calls.push(utterance),
  };
  const option = { engine: "pocket", key: "pocket:azelma", label: "Azelma" };
  speakPreview(option, synth);
  assert.deepEqual(calls, ["cancel"], "a pocket preview must never call speak");
});

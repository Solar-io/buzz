import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAgentVoiceContent } from "./agentVoiceSelection.ts";
import { parseAgentVoiceAssignmentEvent } from "./agentVoiceAssignment.ts";
import { resolveEffectiveVoice } from "./voicePrecedence.ts";
import { previewRequestFor, summarizeAgentVoice } from "./agentVoiceSummary.ts";
import { selectionToBridgeRequest } from "../../huddle/lib/bridgeSpeech.ts";
import { speakRoute } from "../../huddle/lib/huddleAgentSpeech.ts";
import {
  loadHuddlePrefs,
  saveHuddlePrefs,
} from "../../huddle/lib/huddlePrefs.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../test-fixtures/voice/voice-key-grammar.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
for (const [engine, accepted, rejected] of [
  ["fish", 4, 19],
  ["eleven", 4, 18],
]) {
  test(`${engine} grammar vectors accept the shared corpus`, () => {
    assert.equal(vectors[engine].accept.length, accepted);
    for (const key of vectors[engine].accept)
      assert.deepEqual(
        parseAgentVoiceContent(
          JSON.stringify({ version: 1, engine, key, label: "Voice" }),
        ),
        { selection: { engine, key }, label: "Voice" },
        key,
      );
  });
  test(`${engine} grammar vectors reject the shared corpus`, () => {
    assert.equal(vectors[engine].reject.length, rejected);
    for (const key of vectors[engine].reject)
      assert.equal(
        parseAgentVoiceContent(
          JSON.stringify({ version: 1, engine, key, label: "Voice" }),
        ),
        null,
        JSON.stringify(key),
      );
  });
}

const selection = {
  engine: "fish",
  key: "fish:0123456789abcdef0123456789abcdef",
};
test("fish assignment shares selection grammar and effective voice precedence", () => {
  const row = parseAgentVoiceAssignmentEvent({
    pubkey: "a".repeat(64),
    created_at: 1,
    tags: [["d", "b".repeat(64)]],
    content: JSON.stringify({ version: 1, ...selection, label: "Jame" }),
  });
  assert.deepEqual(row.selection, selection);
  assert.deepEqual(
    resolveEffectiveVoice({
      assignment: selection,
      self: { engine: "chatterbox", key: "chatterbox:anna" },
    }),
    { selection, source: "owner" },
  );
  assert.deepEqual(
    resolveEffectiveVoice({
      override: selection,
      assignment: { engine: "eleven", key: "eleven:abcdefghij" },
    }),
    { selection, source: "channel" },
  );
  assert.deepEqual(resolveEffectiveVoice({ self: selection }), {
    selection,
    source: "agent",
  });
});
test("fish summaries and preview preserve the selected engine and stored label", () => {
  assert.equal(
    summarizeAgentVoice({
      agentPubkey: "b".repeat(64),
      assignment: { selection, label: "Jame" },
      roster: [],
    }).voice,
    "Jame (Fish Audio)",
  );
  assert.deepEqual(previewRequestFor("b".repeat(64), selection), selection);
});
test("fish bridge mapping and speech disposition route the bare model id", () => {
  const expected = {
    engine: "fish",
    voice: "0123456789abcdef0123456789abcdef",
  };
  assert.deepEqual(selectionToBridgeRequest(selection), expected);
  const route = speakRoute("b".repeat(64), [], selection);
  assert.equal(route.disposition, "fish-bridge");
  assert.deepEqual(route.bridge, expected);
});
test("fish override round-trips with its stored label and remains the channel winner", () => {
  const values = new Map();
  const store = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  saveHuddlePrefs(store, "room", {
    voice: { ...selection, label: "Jame" },
    duplex: "half",
  });
  assert.deepEqual(loadHuddlePrefs(store, "room"), {
    voice: { ...selection, label: "Jame" },
    duplex: "half",
    // Saved without an output: reads back as the safe default.
    output: "speakers",
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inUseBy,
  localVoiceOverrides,
  parseVoiceInput,
  parseLibraryVoices,
  isOutsideLibrary,
} from "./voiceLibraryModel.ts";
const id = "0123456789abcdef0123456789abcdef";
const selection = { engine: "fish", key: `fish:${id}` };

test("parseVoiceInput accepts Fish ids and provider URLs and refuses malformed inputs", () => {
  assert.equal(parseVoiceInput("fish", id), id);
  assert.equal(parseVoiceInput("fish", `https://fish.audio/m/${id}`), id);
  assert.equal(
    parseVoiceInput("eleven", "T720RsqorTx4ZZWohrNN"),
    "T720RsqorTx4ZZWohrNN",
  );
  assert.equal(
    parseVoiceInput(
      "eleven",
      "https://elevenlabs.io/app/voice-library?voiceId=T720RsqorTx4ZZWohrNN",
    ),
    "T720RsqorTx4ZZWohrNN",
  );
  for (const input of [
    "",
    "short",
    "fish:has space",
    `https://evil.test/m/${id}`,
    `http://fish.audio/m/${id}`,
    `https://fish.audio@evil.test/m/${id}`,
    `https://fish.audio/model/${id}`,
  ])
    assert.throws(() => parseVoiceInput("fish", input), Error, input);
});
test("inUseBy includes owner assignments, agent choices and every matching device room", () => {
  const assignments = [{ agentPubkey: "agent-a", selection }];
  const selections = [
    { pubkey: "agent-b", selection },
    {
      pubkey: "other",
      selection: { engine: "local-synth", voiceURI: selection.key },
    },
  ];
  const overrides = [
    { channelId: "room-1", selection },
    {
      channelId: "room-2",
      selection: { engine: "eleven", key: "eleven:abcdefghij" },
    },
  ];
  assert.deepEqual(inUseBy(selection.key, assignments, selections, overrides), [
    { source: "assignment", pubkey: "agent-a" },
    { source: "selection", pubkey: "agent-b" },
    { source: "huddle", channelId: "room-1" },
  ]);
});
test("localVoiceOverrides scans prefs, tolerates corruption and preserves stored bytes", () => {
  const values = new Map([
    [
      "buzz.huddle.prefs.room",
      JSON.stringify({ voice: selection, duplex: "half" }),
    ],
    ["buzz.huddle.prefs.bad", "garbage"],
    ["unrelated", "{}"],
  ]);
  const before = [...values];
  const store = {
    length: values.size,
    key: (i) => [...values.keys()][i],
    getItem: (key) => values.get(key) ?? null,
  };
  assert.deepEqual(localVoiceOverrides(store), [
    { channelId: "room", selection },
  ]);
  assert.deepEqual([...values], before);
  assert.deepEqual(
    localVoiceOverrides({
      get length() {
        throw new Error("blocked");
      },
    }),
    [],
  );
});
test("membership is presentation only and untrusted response rows are validated", () => {
  assert.ok(isOutsideLibrary(selection, []));
  assert.ok(!isOutsideLibrary(selection, [{ id, label: "Jame" }]));
  assert.ok(!isOutsideLibrary({ engine: "pocket", key: "pocket:anna" }, []));
  assert.deepEqual(
    parseLibraryVoices({
      voices: [
        null,
        { id, label: "Jame", detail: "by author" },
        { id: 1, label: "bad" },
      ],
    }),
    [{ id, label: "Jame", detail: "by author" }],
  );
  assert.throws(() => parseLibraryVoices({ error: "bad" }));
});

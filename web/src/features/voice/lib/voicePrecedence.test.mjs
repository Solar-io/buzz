import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEffectiveVoice, voiceSourceLabel } from "./voicePrecedence.ts";
import { resolveHuddleVoice } from "../../huddle/lib/huddlePrefs.ts";

// AC-W1: channel override > owner assignment (30183) > agent's own 30182 >
// derived. Four DISTINCT values per layer, so every case discriminates
// which layer won (no "equal on both sides").
const CHANNEL = { engine: "eleven", key: "eleven:T720RsqorTx4ZZWohrNN" };
const OWNER = { engine: "chatterbox", key: "chatterbox:evie" };
const SELF = { engine: "pocket", key: "pocket:anna" };
const ROBOT = { engine: "local-synth", voiceURI: "uri:daniel" };

const MATRIX = [
  // [name, layers, expected selection, expected source]
  [
    "all four layers: the channel override wins",
    { override: CHANNEL, assignment: OWNER, self: SELF },
    CHANNEL,
    "channel",
  ],
  [
    "no override: the owner assignment beats the agent's own",
    { override: null, assignment: OWNER, self: SELF },
    OWNER,
    "owner",
  ],
  [
    "no override, no assignment: the agent's own speaks",
    { assignment: undefined, self: SELF },
    SELF,
    "agent",
  ],
  ["nothing: derived", {}, undefined, "derived"],
  [
    "override beats assignment alone",
    { override: CHANNEL, assignment: OWNER },
    CHANNEL,
    "channel",
  ],
  [
    "override beats self alone",
    { override: CHANNEL, self: SELF },
    CHANNEL,
    "channel",
  ],
  [
    "a local-synth assignment counts as none: self speaks",
    { assignment: ROBOT, self: SELF },
    SELF,
    "agent",
  ],
  [
    "a local-synth self row counts as none: derived",
    { self: ROBOT },
    undefined,
    "derived",
  ],
  [
    "local-synth at both layers: derived",
    { assignment: ROBOT, self: ROBOT },
    undefined,
    "derived",
  ],
];

for (const [name, layers, selection, source] of MATRIX) {
  test(`precedence: ${name}`, () => {
    const got = resolveEffectiveVoice(layers);
    assert.equal(got.source, source);
    if (selection === undefined) {
      assert.equal(got.selection, undefined);
    } else {
      assert.deepEqual(got.selection, {
        engine: selection.engine,
        key: selection.key,
      });
    }
  });
}

test("the matrix is the size it claims (guard against a vacuous loop)", () => {
  assert.equal(MATRIX.length, 9);
});

test("resolveHuddleVoice (the speak seam) threads the assignment layer", () => {
  assert.deepEqual(resolveHuddleVoice(null, SELF, OWNER), OWNER);
  assert.deepEqual(resolveHuddleVoice(CHANNEL, SELF, OWNER), CHANNEL);
  assert.deepEqual(resolveHuddleVoice(null, SELF), SELF);
  assert.equal(resolveHuddleVoice(null, ROBOT), undefined);
});

test("source chip copy is one spelling everywhere", () => {
  assert.equal(voiceSourceLabel("owner", true), "set by you");
  assert.equal(voiceSourceLabel("owner", false), "set by owner");
  assert.equal(voiceSourceLabel("agent"), "agent's choice");
  assert.equal(voiceSourceLabel("derived"), "default");
  assert.equal(voiceSourceLabel("channel"), "this channel only");
});

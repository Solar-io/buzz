import assert from "node:assert/strict";
import { test } from "node:test";

import { previewRequestFor, summarizeAgentVoice } from "./agentVoiceSummary.ts";
import { derivedBridgeVoice } from "../../huddle/lib/bridgeSpeech.ts";

// The strings the Agent voices card and the hover/profile card render
// (AC-W5: `Evie (Chatterbox) · set by owner`).
const AGENT = "d".repeat(64);
const ROSTER = [
  {
    key: "chatterbox:evie",
    slug: "evie",
    label: "Evie",
    gender: "female",
    style: "",
    reserved: true,
    reservedFor: null,
  },
  {
    key: "chatterbox:theo",
    slug: "theo",
    label: "Theo",
    gender: "male",
    style: "",
    reserved: false,
    reservedFor: null,
  },
];
const OWNER_ROW = {
  selection: { engine: "chatterbox", key: "chatterbox:evie" },
  label: "Evie",
};
const SELF_ROW = {
  selection: { engine: "eleven", key: "eleven:T720RsqorTx4ZZWohrNN" },
  label: "Roger",
};

test("an owner assignment reads `Evie (Chatterbox)` · set by owner / set by you", () => {
  const hover = summarizeAgentVoice({
    agentPubkey: AGENT,
    assignment: OWNER_ROW,
    self: SELF_ROW,
    roster: [],
  });
  assert.equal(
    `${hover.voice} · ${hover.sourceLabel}`,
    "Evie (Chatterbox) · set by owner",
  );
  const card = summarizeAgentVoice({
    agentPubkey: AGENT,
    assignment: OWNER_ROW,
    self: SELF_ROW,
    roster: ROSTER,
    viewerIsOwner: true,
  });
  assert.equal(card.sourceLabel, "set by you");
  assert.equal(card.source, "owner");
});

test("the agent's own choice reads with its published label and engine", () => {
  const s = summarizeAgentVoice({
    agentPubkey: AGENT,
    assignment: undefined,
    self: SELF_ROW,
    roster: ROSTER,
  });
  assert.equal(
    `${s.voice} · ${s.sourceLabel}`,
    "Roger (ElevenLabs) · agent's choice",
  );
});

test("no selection names the derived Chatterbox voice and says default", () => {
  const slug = derivedBridgeVoice(AGENT).voice;
  const s = summarizeAgentVoice({
    agentPubkey: AGENT,
    assignment: undefined,
    self: undefined,
    roster: [],
  });
  assert.equal(s.source, "derived");
  assert.equal(
    s.voice,
    `${slug[0].toUpperCase()}${slug.slice(1)} (Chatterbox)`,
  );
  assert.equal(s.sourceLabel, "default");
});

test("a roster label wins over a slug for chatterbox keys", () => {
  const s = summarizeAgentVoice({
    agentPubkey: AGENT,
    assignment: {
      selection: { engine: "chatterbox", key: "chatterbox:theo" },
      label: "whatever",
    },
    self: undefined,
    roster: ROSTER,
  });
  assert.equal(s.voice, "Theo (Chatterbox)");
});

test("previews go through the effective voice's own engine", () => {
  assert.deepEqual(previewRequestFor(AGENT, OWNER_ROW.selection), {
    engine: "chatterbox",
    key: "chatterbox:evie",
  });
  assert.deepEqual(
    previewRequestFor(AGENT, { engine: "pocket", key: "pocket:anna" }),
    { engine: "chatterbox", key: "chatterbox:anna" },
  );
  assert.deepEqual(previewRequestFor(AGENT, undefined), {
    engine: "chatterbox",
    key: `chatterbox:${derivedBridgeVoice(AGENT).voice}`,
  });
});

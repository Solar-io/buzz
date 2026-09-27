import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KIND_AGENT_VOICE_ASSIGNMENT,
  assignmentCoordinate,
  parseAgentVoiceAssignmentEvent,
  reduceAgentVoiceAssignmentEvents,
} from "./agentVoiceAssignment.ts";

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);
const AGENT2 = "c".repeat(64);
const BODY = {
  version: 1,
  engine: "chatterbox",
  key: "chatterbox:evie",
  label: "Evie",
};

function assignment(overrides = {}) {
  return {
    kind: KIND_AGENT_VOICE_ASSIGNMENT,
    pubkey: OWNER,
    content: JSON.stringify(BODY),
    created_at: 1_700_000_000,
    tags: [["d", AGENT]],
    ...overrides,
  };
}

test("the kind constant pins 30183", () => {
  assert.equal(KIND_AGENT_VOICE_ASSIGNMENT, 30183);
  assert.equal(
    assignmentCoordinate(OWNER.toUpperCase(), AGENT),
    `30183:${OWNER}:${AGENT}`,
  );
});

test("an owner assignment parses with agent (d) and owner (author)", () => {
  const row = parseAgentVoiceAssignmentEvent(assignment());
  assert.equal(row.agentPubkey, AGENT);
  assert.equal(row.ownerPubkey, OWNER);
  assert.deepEqual(row.selection, {
    engine: "chatterbox",
    key: "chatterbox:evie",
  });
  assert.equal(row.label, "Evie");
});

test("parse rejects a d that is not 64 lowercase hex (AC-R3 mirror)", () => {
  for (const d of [
    AGENT.toUpperCase(),
    "b".repeat(63),
    "agent-voice",
    `${"b".repeat(63)}g`,
  ]) {
    assert.equal(
      parseAgentVoiceAssignmentEvent(assignment({ tags: [["d", d]] })),
      null,
      d,
    );
  }
  assert.equal(
    parseAgentVoiceAssignmentEvent(assignment({ tags: [] })),
    null,
    "no d",
  );
  assert.equal(
    parseAgentVoiceAssignmentEvent(
      assignment({
        tags: [
          ["d", AGENT],
          ["d", AGENT2],
        ],
      }),
    ),
    null,
    "two d tags",
  );
});

test("parse applies the SAME body grammar as 30182", () => {
  const bad = [
    { ...BODY, key: "chatterbox:Evie" },
    { ...BODY, version: 2 },
    { ...BODY, engine: "siri" },
    { ...BODY, engine: "pocket", key: "pocket:eve" },
    { ...BODY, label: "" },
  ];
  for (const body of bad) {
    assert.equal(
      parseAgentVoiceAssignmentEvent(
        assignment({ content: JSON.stringify(body) }),
      ),
      null,
      JSON.stringify(body),
    );
  }
  assert.equal(
    parseAgentVoiceAssignmentEvent(assignment({ content: "{" })),
    null,
  );
});

test("reduce keys by agent, newest wins in either arrival order", () => {
  const older = assignment({
    content: JSON.stringify({ ...BODY, key: "chatterbox:iris", label: "Iris" }),
  });
  const newer = assignment({ created_at: 1_700_000_100 });
  for (const order of [
    [older, newer],
    [newer, older],
  ]) {
    const rows = reduceAgentVoiceAssignmentEvents(order);
    assert.equal(rows.size, 1);
    assert.equal(rows.get(AGENT).selection.key, "chatterbox:evie");
  }
});

test("a coordinate delete by the owner clears the row; an older delete does not", () => {
  const row = assignment({ created_at: 1_700_000_100 });
  const del = (created_at, pubkey = OWNER) => ({
    kind: 5,
    pubkey,
    content: "",
    created_at,
    tags: [["a", `30183:${OWNER}:${AGENT}`]],
  });
  assert.equal(
    reduceAgentVoiceAssignmentEvents([row, del(1_700_000_200)]).size,
    0,
  );
  assert.equal(
    reduceAgentVoiceAssignmentEvents([del(1_700_000_200), row]).size,
    0,
  );
  assert.equal(
    reduceAgentVoiceAssignmentEvents([row, del(1_700_000_050)]).size,
    1,
    "older delete",
  );
  assert.equal(
    reduceAgentVoiceAssignmentEvents([row, del(1_700_000_200, AGENT2)]).size,
    1,
    "a stranger's delete of the owner's coordinate is ignored",
  );
});

test("reduce keeps distinct agents apart", () => {
  const rows = reduceAgentVoiceAssignmentEvents([
    assignment(),
    assignment({
      tags: [["d", AGENT2]],
      content: JSON.stringify({
        ...BODY,
        key: "chatterbox:theo",
        label: "Theo",
      }),
    }),
  ]);
  assert.equal(rows.size, 2);
  assert.equal(rows.get(AGENT2).label, "Theo");
});

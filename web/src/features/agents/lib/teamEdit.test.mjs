import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTeamCreate,
  buildTeamUpdate,
  mergeMemberSelection,
  teamDeleteBlockers,
} from "./teamEdit.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function edits(overrides = {}) {
  return {
    name: "T",
    description: "",
    instructions: "",
    personaIds: null,
    ...overrides,
  };
}

function head(content, overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30176,
    created_at: 1000,
    tags: [
      ["d", UUID],
      ["zz", "1"],
    ],
    content,
    sig: "0".repeat(128),
    ...overrides,
  };
}

test("create: minimal content is exact", () => {
  const result = buildTeamCreate(edits({ name: "  T " }), UUID, 5);
  assert.equal(
    result.template.content,
    '{"name":"T","instructions":null,"persona_ids":[]}',
  );
  assert.deepEqual(result.template.tags, [["d", UUID]]);
  assert.equal(result.template.kind, 30176);
  assert.equal(result.template.created_at, 5);
});

test("create: full content in serde order", () => {
  const result = buildTeamCreate(
    edits({
      description: " D ",
      instructions: " Do it. ",
      personaIds: ["p1", "p2"],
    }),
    UUID,
    5,
  );
  assert.equal(
    result.template.content,
    '{"name":"T","description":"D","instructions":"Do it.","persona_ids":["p1","p2"]}',
  );
});

test("create: blank name and non-UUID d refused", () => {
  assert.equal(
    buildTeamCreate(edits({ name: " " }), UUID, 1).error,
    "Team name is required",
  );
  assert.equal(
    buildTeamCreate(edits(), "team-slug", 1).error,
    "Internal error: the new team id is not a UUID.",
  );
});

const FULL =
  '{"name":"T","x_future":{"a":1},"description":"D","instructions":"old","persona_ids":["p1","ghost"]}';

test("update: only the changed key is rewritten; unknown key survives", () => {
  const result = buildTeamUpdate(
    head(FULL),
    edits({ description: "D", instructions: "new" }),
    5,
  );
  assert.equal(
    result.template.content,
    '{"name":"T","x_future":{"a":1},"description":"D","instructions":"new","persona_ids":["p1","ghost"]}',
  );
  assert.deepEqual(result.template.tags, [
    ["d", UUID],
    ["zz", "1"],
  ]);
});

test("update: absent persona_ids stays absent when personaIds is null", () => {
  const result = buildTeamUpdate(
    head('{"name":"Old"}'),
    edits({ name: "New" }),
    5,
  );
  assert.equal(result.template.content, '{"name":"New"}');
});

test("update: absent instructions stays absent when left blank", () => {
  const result = buildTeamUpdate(
    head('{"name":"T","persona_ids":[]}'),
    edits({ description: "added" }),
    5,
  );
  assert.equal(
    result.template.content,
    '{"name":"T","persona_ids":[],"description":"added"}',
  );
});

test("update: membership edit replaces the list; unchanged list is not a change", () => {
  const result = buildTeamUpdate(
    head(FULL),
    edits({ description: "D", instructions: "old", personaIds: ["p1", "ghost", "p3"] }),
    5,
  );
  assert.deepEqual(JSON.parse(result.template.content).persona_ids, [
    "p1",
    "ghost",
    "p3",
  ]);
  assert.equal(
    buildTeamUpdate(
      head(FULL),
      edits({ description: "D", instructions: "old", personaIds: ["p1", "ghost"] }),
      5,
    ).error,
    "No changes to save.",
  );
});

test("mergeMemberSelection preserves unresolved ids", () => {
  assert.deepEqual(
    mergeMemberSelection(
      ["p1", "ghost", "p2"],
      new Set(["p1", "p2", "p3"]),
      new Set(["p2", "p3"]),
    ),
    ["ghost", "p2", "p3"],
  );
});

test("update: created_at is monotonic over the head", () => {
  assert.equal(
    buildTeamUpdate(head(FULL), edits({ name: "N", description: "D", instructions: "old" }), 5)
      .template.created_at,
    1001,
  );
  assert.equal(
    buildTeamUpdate(head(FULL), edits({ name: "N", description: "D", instructions: "old" }), 9000)
      .template.created_at,
    9000,
  );
});

const team = (overrides = {}) => ({
  id: UUID,
  membershipUnknown: false,
  personaIds: ["p1"],
  ...overrides,
});

test("teamDeleteBlockers: non-UUID team", () => {
  assert.equal(
    teamDeleteBlockers(team({ id: "builtin-team:x" }), []),
    "Delete this team in the desktop app.",
  );
});

test("teamDeleteBlockers: membership unknown fails closed", () => {
  assert.equal(
    teamDeleteBlockers(team({ membershipUnknown: true }), []),
    "Delete this team in the desktop app.",
  );
});

test("teamDeleteBlockers: referencing agents refuse", () => {
  assert.equal(
    teamDeleteBlockers(team(), [
      { entry: { personaId: "p1" }, name: "A" },
      { entry: { personaId: "p9" }, name: "Z" },
    ]),
    "Cannot delete team: 1 agent(s) still reference it (A). Delete or reconfigure them first.",
  );
});

test("teamDeleteBlockers: clear", () => {
  assert.equal(
    teamDeleteBlockers(team(), [{ entry: { personaId: null }, name: "N" }]),
    null,
  );
});

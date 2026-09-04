import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_GROUP_WINDOW_SECONDS,
  groupAgentNotes,
} from "./groupAgentNotes.ts";

const AGENT_A = "aa".repeat(32);
const AGENT_B = "bb".repeat(32);
const T = 1_800_000_000;

function note(id, pubkey, createdAt) {
  return { id, pubkey, createdAt, content: id, tags: [] };
}

test("the default window is five minutes", () => {
  assert.equal(AGENT_GROUP_WINDOW_SECONDS, 300);
});

test("an empty feed groups to nothing", () => {
  assert.deepEqual(groupAgentNotes([]), []);
});

test("one note becomes one group of one", () => {
  const groups = groupAgentNotes([note("n1", AGENT_A, T)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pubkey, AGENT_A);
  assert.deepEqual(
    groups[0].notes.map((n) => n.id),
    ["n1"],
  );
  assert.equal(groups[0].latestAt, T);
  assert.equal(groups[0].earliestAt, T);
});

test("a burst from one agent collapses into one group", () => {
  const groups = groupAgentNotes([
    note("n3", AGENT_A, T),
    note("n2", AGENT_A, T - 100),
    note("n1", AGENT_A, T - 200),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].notes.map((n) => n.id),
    ["n3", "n2", "n1"],
  );
  assert.equal(groups[0].latestAt, T);
  assert.equal(groups[0].earliestAt, T - 200);
});

test("a gap larger than the window starts a new group", () => {
  const groups = groupAgentNotes([
    note("late", AGENT_A, T),
    note("early", AGENT_A, T - 301),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.notes.map((n) => n.id)),
    [["late"], ["early"]],
  );
});

test("a gap exactly at the window still joins", () => {
  const groups = groupAgentNotes([
    note("late", AGENT_A, T),
    note("early", AGENT_A, T - 300),
  ]);
  assert.equal(groups.length, 1);
});

test("a different agent always starts a new group", () => {
  const groups = groupAgentNotes([
    note("a1", AGENT_A, T),
    note("b1", AGENT_B, T - 1),
    note("a2", AGENT_A, T - 2),
  ]);
  assert.deepEqual(
    groups.map((group) => group.pubkey),
    [AGENT_A, AGENT_B, AGENT_A],
  );
});

test("the window is measured against the PREVIOUS note, not the group start", () => {
  // Notes 200s apart chain into one group across a 600s total span. Comparing
  // against the group's earliest would split them, which would break a long
  // steady stream of agent output into arbitrary chunks.
  const groups = groupAgentNotes([
    note("n4", AGENT_A, T),
    note("n3", AGENT_A, T - 200),
    note("n2", AGENT_A, T - 400),
    note("n1", AGENT_A, T - 600),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].latestAt - groups[0].earliestAt, 600);
});

test("a custom window is honoured", () => {
  const notes = [note("n2", AGENT_A, T), note("n1", AGENT_A, T - 60)];
  assert.equal(groupAgentNotes(notes, 30).length, 2);
  assert.equal(groupAgentNotes(notes, 120).length, 1);
});

test("every input note lands in exactly one group", () => {
  const notes = [
    note("a1", AGENT_A, T),
    note("a2", AGENT_A, T - 10),
    note("b1", AGENT_B, T - 20),
    note("a3", AGENT_A, T - 1_000),
  ];
  const groups = groupAgentNotes(notes);
  const flattened = groups.flatMap((group) => group.notes.map((n) => n.id));
  assert.equal(flattened.length, notes.length);
  assert.deepEqual(new Set(flattened), new Set(notes.map((n) => n.id)));
});

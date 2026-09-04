import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIND_GROUPS,
  REACTION_KIND,
  defaultGroupIds,
  kindsForGroups,
  toggleGroupId,
} from "./exportKinds.ts";
import {
  DELETE_KIND,
  EDIT_KIND,
  MESSAGE_SEARCH_KINDS,
} from "../../channels/lib/messageBuffer.ts";
import { SYSTEM_MESSAGE_KIND } from "../../channels/lib/systemEvent.ts";

test("every timeline message kind is offered for export", () => {
  const messages = KIND_GROUPS.find((group) => group.id === "messages");
  assert.ok(messages, "the messages group exists");
  for (const kind of MESSAGE_SEARCH_KINDS) {
    assert.ok(
      messages.kinds.includes(kind),
      `kind ${kind} renders in the timeline but is not exportable`,
    );
  }
});

test("group ids are unique and no kind appears in two groups", () => {
  const ids = KIND_GROUPS.map((group) => group.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate group id");
  const all = KIND_GROUPS.flatMap((group) => group.kinds);
  assert.equal(new Set(all).size, all.length, "a kind is in two groups");
});

test("the defaults cover the conversation and the overlays that correct it", () => {
  const kinds = kindsForGroups(defaultGroupIds());
  for (const kind of MESSAGE_SEARCH_KINDS) {
    assert.ok(kinds.includes(kind), `kind ${kind} missing from the default`);
  }
  assert.ok(kinds.includes(EDIT_KIND), "edits are on by default");
  assert.ok(kinds.includes(DELETE_KIND), "deletions are on by default");
});

test("the noisy groups are off by default", () => {
  const kinds = kindsForGroups(defaultGroupIds());
  assert.equal(
    kinds.includes(REACTION_KIND),
    false,
    "reactions are opt-in — they dominate a busy channel",
  );
  assert.equal(kinds.includes(SYSTEM_MESSAGE_KIND), false);
});

test("kindsForGroups returns a sorted, deduped list", () => {
  const kinds = kindsForGroups(new Set(["messages", "overlays", "reactions"]));
  assert.deepEqual(
    kinds,
    [...kinds].sort((a, b) => a - b),
    "sorted",
  );
  assert.equal(new Set(kinds).size, kinds.length, "deduped");
});

test("an empty selection resolves to no kinds — the export refuses to run", () => {
  assert.deepEqual(kindsForGroups(new Set()), []);
});

test("an unknown persisted group id is ignored rather than throwing", () => {
  assert.deepEqual(kindsForGroups(new Set(["not-a-group"])), []);
  assert.deepEqual(
    kindsForGroups(new Set(["messages", "not-a-group"])),
    kindsForGroups(new Set(["messages"])),
  );
});

test("toggling adds, toggling again removes, and the input is untouched", () => {
  const start = new Set(["messages"]);
  const added = toggleGroupId("reactions", start);
  assert.deepEqual([...added].sort(), ["messages", "reactions"]);
  const removed = toggleGroupId("reactions", added);
  assert.deepEqual([...removed], ["messages"]);
  assert.deepEqual([...start], ["messages"], "the caller's set is not mutated");
});

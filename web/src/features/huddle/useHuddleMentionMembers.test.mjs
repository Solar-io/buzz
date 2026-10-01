import assert from "node:assert/strict";
import { test } from "node:test";

import { huddleMentionMembers } from "./useHuddleMentionMembers.ts";

const SELF = "a".repeat(64);
const SILENT_AGENT = "b".repeat(64);
const OTHER = "c".repeat(64);

test("the shared huddle roster keeps silent members for typed mentions", () => {
  assert.deepEqual(
    huddleMentionMembers([SELF, SILENT_AGENT, OTHER, SILENT_AGENT]),
    [
      { pubkey: SELF, name: "aaaaaaaa…aaaa" },
      { pubkey: SILENT_AGENT, name: "bbbbbbbb…bbbb" },
      { pubkey: OTHER, name: "cccccccc…cccc" },
    ],
  );
});

test("the snapshot's roles ride on the members (a scratch owner is known)", () => {
  assert.deepEqual(
    huddleMentionMembers(
      [SELF, OTHER],
      new Map([
        [SELF, "owner"],
        [OTHER, "member"],
      ]),
    ),
    [
      { pubkey: SELF, name: "aaaaaaaa…aaaa", role: "owner" },
      { pubkey: OTHER, name: "cccccccc…cccc", role: "member" },
    ],
  );
});

test("a changed room cannot reuse a previous huddle roster", () => {
  assert.deepEqual(huddleMentionMembers([OTHER]), [
    { pubkey: OTHER, name: "cccccccc…cccc" },
  ]);
});

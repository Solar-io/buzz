import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractDTag,
  extractNotBefore,
  parseNotBefore,
  parseReminderContent,
  pickHeads,
  replacementCreatedAt,
} from "./reminderContent.ts";

test("parseNotBefore accepts a plain decimal timestamp", () => {
  assert.equal(parseNotBefore("1770000000"), 1_770_000_000);
  assert.equal(parseNotBefore("0"), 0);
});

test("parseNotBefore rejects everything the relay calls malformed", () => {
  // NIP-ER: ASCII digits only, no sign, whitespace, decimal point, or leading
  // zero except "0". Number() would happily coerce most of these.
  for (const raw of [
    "",
    " 1770000000",
    "1770000000 ",
    "+1770000000",
    "-1",
    "1770000000.0",
    "1e9",
    "017",
    "0x10",
    "not-a-number",
  ]) {
    assert.equal(
      parseNotBefore(raw),
      undefined,
      `accepted ${JSON.stringify(raw)}`,
    );
  }
});

test("parseNotBefore rejects a value past MAX_SAFE_INTEGER", () => {
  assert.equal(parseNotBefore("9007199254740991"), 9_007_199_254_740_991);
  assert.equal(parseNotBefore("9007199254740993"), undefined);
});

test("extractNotBefore refuses a duplicated tag rather than picking one", () => {
  assert.equal(extractNotBefore([["not_before", "100"]]), 100);
  assert.equal(
    extractNotBefore([
      ["not_before", "100"],
      ["not_before", "200"],
    ]),
    undefined,
  );
  assert.equal(extractNotBefore([["d", "x"]]), undefined);
});

test("extractDTag requires exactly one non-empty d tag", () => {
  assert.equal(extractDTag([["d", "abc"]]), "abc");
  assert.equal(extractDTag([["d", ""]]), null);
  assert.equal(extractDTag([]), null);
  assert.equal(
    extractDTag([
      ["d", "a"],
      ["d", "b"],
    ]),
    null,
  );
});

test("parseReminderContent reads the desktop's target shape", () => {
  const content = parseReminderContent(
    JSON.stringify({
      status: "pending",
      note: "follow up",
      target: {
        eventId: "e".repeat(64),
        channelId: "chan-1",
        preview: "ship it",
        authorPubkey: "a".repeat(64),
      },
    }),
  );
  assert.equal(content.status, "pending");
  assert.equal(content.note, "follow up");
  assert.equal(content.target.channelId, "chan-1");
  assert.equal(content.target.preview, "ship it");
});

test("parseReminderContent keeps a NIP-ER shaped target instead of dropping it", () => {
  // Another client's spec-shaped reminder: no channel, so not navigable, but
  // showing it beats making it invisible.
  const content = parseReminderContent(
    JSON.stringify({
      status: "pending",
      target: { id: "b".repeat(64), preview: "from elsewhere" },
    }),
  );
  assert.equal(content.target.eventId, "b".repeat(64));
  assert.equal(content.target.channelId, "");
  assert.equal(content.target.preview, "from elsewhere");
});

test("parseReminderContent accepts a note-only reminder", () => {
  const content = parseReminderContent(
    JSON.stringify({ status: "pending", note: "buy milk" }),
  );
  assert.deepEqual(content, {
    status: "pending",
    target: undefined,
    note: "buy milk",
  });
});

test("parseReminderContent fails closed on every off-shape payload", () => {
  const cases = {
    "not json": "{",
    "an array": "[]",
    "a bare string": '"hello"',
    null: "null",
    "unknown status": JSON.stringify({ status: "snoozed", note: "x" }),
    "missing status": JSON.stringify({ note: "x" }),
    "non-string note": JSON.stringify({ status: "pending", note: 7 }),
    "empty note and no target": JSON.stringify({ status: "pending", note: "" }),
    "no note and no target": JSON.stringify({ status: "pending" }),
    "malformed target": JSON.stringify({
      status: "pending",
      target: { eventId: 1 },
    }),
  };
  for (const [label, payload] of Object.entries(cases)) {
    assert.equal(parseReminderContent(payload), null, `accepted ${label}`);
  }
});

function head(id, createdAt, eventId, status = "pending", notBefore = 100) {
  return {
    id,
    createdAt,
    eventId,
    notBefore,
    content: { status, note: `${id}@${createdAt}` },
  };
}

test("pickHeads keeps the highest created_at per address", () => {
  const heads = pickHeads([
    head("d1", 100, "e1"),
    head("d1", 200, "e2"),
    head("d2", 50, "e3"),
  ]);
  assert.equal(heads.length, 2);
  const byId = new Map(heads.map((r) => [r.id, r]));
  assert.equal(byId.get("d1").eventId, "e2");
  assert.equal(byId.get("d2").eventId, "e3");
});

test("pickHeads is order-independent", () => {
  // A relay replay can deliver the superseded version last.
  const newest = head("d1", 200, "e2");
  const oldest = head("d1", 100, "e1");
  assert.equal(pickHeads([oldest, newest])[0].eventId, "e2");
  assert.equal(pickHeads([newest, oldest])[0].eventId, "e2");
});

test("pickHeads breaks a created_at tie on the LOWEST event id", () => {
  // NIP-01's tiebreak. Picking the highest would make two clients disagree.
  const heads = pickHeads([head("d1", 100, "ffff"), head("d1", 100, "0001")]);
  assert.equal(heads[0].eventId, "0001");
});

test("replacementCreatedAt uses now when now is ahead of the head", () => {
  assert.equal(replacementCreatedAt(100, 500), 500);
});

test("replacementCreatedAt steps past the head on a same-second replacement", () => {
  // A replacement stamped at or below the head loses under NIP-01 ordering,
  // so the write would silently do nothing.
  assert.equal(replacementCreatedAt(500, 500), 501);
  assert.equal(replacementCreatedAt(500, 400), 501);
});

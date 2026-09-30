import assert from "node:assert/strict";
import test from "node:test";

import {
  editDraft,
  foldItems,
  isValidItemId,
  itemTags,
  itemTemplate,
  KIND_ITEM,
  newItemId,
  nextCreatedAt,
  parseItemEvent,
  validateItemParts,
} from "./itemEvent.ts";

// The literals the Rust suite pins (crates/buzz-core/src/item.rs tests), so
// the two validators are held to the same cases.
const CH_A = "9a1657ac-f7aa-4db0-b632-d8bbeb6dfb50";
const CH_B = "1b2c3d4e-0000-4000-8000-000000000001";
const ITEM_ID = "7f3k2m9qa1bc";
const NOW = 1_759_190_400;
const REPORTER = "a".repeat(64);
const OTHER = "b".repeat(64);

function baseTags(reporter = REPORTER) {
  return [
    ["d", ITEM_ID],
    ["type", "bug"],
    ["status", "open"],
    ["title", "Composer drops the draft"],
    ["created", String(NOW)],
    ["p", reporter, "", "reporter"],
  ];
}

const check = (tags, content = "") =>
  validateItemParts(30623, content, tags, NOW);

const withTag = (tags, ...extra) => [...tags, ...extra];
const replaced = (tags, name, value) =>
  tags.map((tag) => (tag[0] === name ? [tag[0], value, ...tag.slice(2)] : tag));

function head({ id, pubkey = REPORTER, createdAt, status = "open", h = null }) {
  const tags = replaced(baseTags(REPORTER), "status", status);
  if (h) {
    tags.push(["h", h]);
  }
  return {
    id,
    pubkey,
    kind: 30623,
    created_at: createdAt,
    content: "",
    tags,
  };
}

test("the item kind is 30623, addressable", () => {
  assert.equal(KIND_ITEM, 30623);
  assert.ok(KIND_ITEM >= 30000 && KIND_ITEM < 40000);
  assert.equal(check(baseTags()), null);
  assert.equal(
    validateItemParts(30624, "", baseTags(), NOW),
    "wrong kind 30624, expected 30623",
  );
});

test("a non-UUID h is refused — it would store the item as global (R1)", () => {
  assert.equal(
    check(withTag(baseTags(), ["h", "general"])),
    "h must be a lowercase hyphenated channel UUID",
  );
  assert.equal(
    check(withTag(baseTags(), ["h", CH_A.toUpperCase()])),
    "h must be a lowercase hyphenated channel UUID",
  );
  assert.equal(check(withTag(baseTags(), ["h", CH_A])), null);
});

test("cardinality: a second h, a second status, an unroled p, two reporters", () => {
  assert.equal(
    check(withTag(baseTags(), ["h", CH_A], ["h", CH_B])),
    "duplicate h tag",
  );
  assert.equal(
    check(withTag(baseTags(), ["status", "done"])),
    "duplicate status tag",
  );
  assert.equal(
    check(withTag(baseTags(), ["p", OTHER])),
    "p tag must carry role reporter or owner",
  );
  assert.equal(
    check(withTag(baseTags(), ["p", OTHER, "", "reporter"])),
    "exactly one reporter p tag required (got 2)",
  );
  assert.equal(
    check(
      withTag(
        baseTags(),
        ["p", OTHER, "", "owner"],
        ["p", REPORTER, "", "owner"],
      ),
    ),
    "at most one owner p tag (got 2)",
  );
  assert.equal(check(withTag(baseTags(), ["p", OTHER, "", "owner"])), null);
});

test("type and status are closed sets", () => {
  assert.equal(
    check(replaced(baseTags(), "type", "task")),
    'type must be bug or backlog (got "task")',
  );
  assert.equal(
    check(replaced(baseTags(), "status", "closed")),
    'status must be open, progress, needs-you or done (got "closed")',
  );
  for (const status of ["open", "progress", "needs-you", "done"]) {
    assert.equal(check(replaced(baseTags(), "status", status)), null, status);
  }
});

test("title is 1..=200 characters after Rust's trim", () => {
  assert.equal(
    check(replaced(baseTags(), "title", "")),
    "title must be 1..=200 characters (got 0)",
  );
  assert.equal(
    check(replaced(baseTags(), "title", "x".repeat(201))),
    "title must be 1..=200 characters (got 201)",
  );
  assert.equal(check(replaced(baseTags(), "title", "x".repeat(200))), null);
  // Characters, not UTF-16 units: 200 emoji are 400 units.
  assert.equal(check(replaced(baseTags(), "title", "🐝".repeat(200))), null);
  // U+0085 is Rust white space and JS's trim keeps it; U+FEFF is the reverse.
  assert.equal(
    check(replaced(baseTags(), "title", "\u0085")),
    "title must be 1..=200 characters (got 0)",
  );
  assert.equal(
    check(replaced(baseTags(), "title", `\u0085${"x".repeat(200)}`)),
    null,
  );
  assert.equal(
    check(replaced(baseTags(), "title", `﻿${"x".repeat(200)}`)),
    "title must be 1..=200 characters (got 201)",
  );
});

test("the other shape rules: d, created, e, a, summary, project, body", () => {
  assert.equal(
    check(replaced(baseTags(), "d", "7F3K2M9QA1BC")),
    "d must be 12 lowercase Crockford base32 characters",
  );
  assert.equal(
    check(replaced(baseTags(), "d", "7f3k2m9qa1bu")),
    "d must be 12 lowercase Crockford base32 characters",
  );
  assert.equal(
    check(replaced(baseTags(), "created", "soon")),
    "created must be unix seconds",
  );
  assert.equal(
    check(replaced(baseTags(), "created", String(NOW + 601))),
    "created is too far in the future",
  );
  assert.equal(check(replaced(baseTags(), "created", String(NOW + 600))), null);
  assert.equal(
    check(withTag(baseTags(), ["e", "c".repeat(64)])),
    "e tag must carry marker source",
  );
  assert.equal(
    check(withTag(baseTags(), ["e", "c".repeat(64), "", "source"])),
    null,
  );
  assert.equal(
    check(withTag(baseTags(), ["a", `30617:${OTHER}:repo`])),
    "a must be a 30621:<pubkey>:<d> project coordinate",
  );
  assert.equal(check(withTag(baseTags(), ["a", `30621:${OTHER}:web`])), null);
  assert.equal(
    check(withTag(baseTags(), ["summary", "s".repeat(501)])),
    "summary exceeds 500 characters (got 501)",
  );
  assert.equal(
    check(withTag(baseTags(), ["project", "p".repeat(81)])),
    "project exceeds 80 characters (got 81)",
  );
  assert.equal(
    check(baseTags(), "é".repeat(8193)),
    "body exceeds 16384 bytes (got 16386)",
  );
  // Unknown tags ride along (forward compatibility).
  assert.equal(check(withTag(baseTags(), ["priority", "p2"])), null);
});

test("parsing reads every field and skips the clock rule by default", () => {
  const future = {
    ...head({ id: "e1", createdAt: NOW }),
    tags: withTag(
      replaced(baseTags(), "created", String(NOW + 10_000)),
      ["h", CH_A],
      ["summary", "The draft is discarded."],
      ["p", OTHER, "", "owner"],
      ["e", "c".repeat(64), "", "source"],
      ["a", `30621:${OTHER}:web`],
      ["project", "Buzz web"],
    ),
  };
  const parsed = parseItemEvent(future);
  assert.deepEqual(parsed, {
    id: ITEM_ID,
    channelId: CH_A,
    type: "bug",
    status: "open",
    title: "Composer drops the draft",
    summary: "The draft is discarded.",
    body: "",
    created: NOW + 10_000,
    reporter: REPORTER,
    owner: OTHER,
    sourceEventId: "c".repeat(64),
    projectCoordinate: `30621:${OTHER}:web`,
    projectName: "Buzz web",
    updatedAt: NOW,
    updatedBy: REPORTER,
    eventId: "e1",
  });
  // With a clock, the same head is refused — the relay's ingest rule.
  assert.equal(parseItemEvent(future, NOW), null);
});

test("the fold picks the newest head across authors", () => {
  const [item] = foldItems([
    head({ id: "a1", pubkey: REPORTER, createdAt: NOW, status: "open" }),
    head({ id: "b1", pubkey: OTHER, createdAt: NOW + 5, status: "done" }),
  ]);
  assert.equal(item.status, "done");
  assert.equal(item.updatedBy, OTHER);
  assert.equal(item.eventId, "b1");
});

test("a created_at tie goes to the lowest event id", () => {
  const folded = foldItems([
    head({ id: "ff", pubkey: OTHER, createdAt: NOW, status: "done" }),
    head({ id: "0a", pubkey: REPORTER, createdAt: NOW, status: "progress" }),
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].eventId, "0a");
  assert.equal(folded[0].status, "progress");
});

test("the same d in two channels is two items; invalid heads are skipped", () => {
  const folded = foldItems([
    head({ id: "a1", createdAt: NOW, h: CH_A }),
    head({ id: "b1", createdAt: NOW + 1, h: CH_B, status: "done" }),
    { ...head({ id: "x1", createdAt: NOW + 9 }), tags: [["d", ITEM_ID]] },
  ]);
  assert.equal(folded.length, 2);
  assert.deepEqual(
    folded.map((item) => [item.channelId, item.status]),
    [
      [CH_B, "done"],
      [CH_A, "open"],
    ],
  );
});

test("an edit copies the identity tags forward and applies the patch", () => {
  const original = parseItemEvent({
    ...head({ id: "a1", createdAt: NOW + 30 }),
    tags: withTag(baseTags(), ["h", CH_A], ["e", "c".repeat(64), "", "source"]),
  });
  const draft = editDraft(original, { status: "done", owner: OTHER });
  const tags = itemTags(draft);
  const value = (name) => tags.find((tag) => tag[0] === name)?.[1];
  assert.equal(value("h"), CH_A);
  assert.equal(value("created"), String(NOW));
  assert.equal(value("e"), "c".repeat(64));
  assert.deepEqual(
    tags.filter((tag) => tag[0] === "p"),
    [
      ["p", REPORTER, "", "reporter"],
      ["p", OTHER, "", "owner"],
    ],
  );
  assert.equal(value("status"), "done");
  assert.equal(value("title"), "Composer drops the draft");
  // Unassign drops the owner tag; a null summary stays absent.
  assert.equal(
    itemTags(editDraft(original, { owner: null })).some(
      (tag) => tag[3] === "owner",
    ),
    false,
  );
});

test("an edit's created_at strictly supersedes the head it read", () => {
  assert.equal(nextCreatedAt(NOW + 5, NOW), NOW + 6);
  assert.equal(nextCreatedAt(NOW - 100, NOW), NOW);
  assert.equal(nextCreatedAt(null, NOW), NOW);
});

test("the builder emits the SDK's tag order and passes the validator", () => {
  const built = itemTemplate(
    {
      d: ITEM_ID,
      channelId: CH_A,
      type: "backlog",
      status: "open",
      title: "  Scratch channels keep the parent's pinned agents  ",
      summary: "/new copies members and agents only.",
      body: "",
      created: NOW,
      reporter: REPORTER,
      owner: OTHER,
      sourceEventId: "c".repeat(64),
      projectCoordinate: `30621:${OTHER}:web`,
      projectName: "Buzz web",
    },
    NOW + 1,
    NOW,
  );
  assert.equal(built.ok, true);
  assert.equal(built.template.kind, 30623);
  assert.equal(built.template.created_at, NOW + 1);
  assert.deepEqual(
    built.template.tags.map((tag) => tag[0]),
    [
      "d",
      "h",
      "type",
      "status",
      "title",
      "summary",
      "created",
      "p",
      "p",
      "e",
      "a",
      "project",
    ],
  );
  assert.equal(
    built.template.tags[4][1],
    "Scratch channels keep the parent's pinned agents",
  );
  const refused = itemTemplate(
    {
      ...editDraft(parseItemEvent(head({ id: "a", createdAt: NOW })), {}),
      channelId: "general",
    },
    NOW,
    NOW,
  );
  assert.deepEqual(refused, {
    ok: false,
    error: "h must be a lowercase hyphenated channel UUID",
  });
});

test("new ids are 12 Crockford characters from 60 random bits", () => {
  for (let i = 0; i < 50; i += 1) {
    assert.ok(isValidItemId(newItemId()));
  }
  // Each byte contributes its low five bits: 0..31 walks the alphabet.
  const fixed = newItemId((bytes) => bytes.map((_, index) => index + 32));
  assert.equal(fixed, "0123456789ab");
});

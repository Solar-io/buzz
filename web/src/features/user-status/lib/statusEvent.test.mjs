import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeStatus,
  buildUserStatusEvent,
  buildUserStatusTags,
  isStatusExpired,
  parseUserStatusEvent,
  reduceStatusEvents,
  statusLabel,
} from "./statusEvent.ts";

const AUTHOR = "a".repeat(64);
const OTHER = "b".repeat(64);

function statusEvent(overrides = {}) {
  return {
    pubkey: AUTHOR,
    content: "Vacationing",
    created_at: 1_700_000_000,
    tags: [
      ["d", "general"],
      ["emoji", "🏖️"],
    ],
    ...overrides,
  };
}

// ── Serialise ──────────────────────────────────────────────────────────────
// The expected shape is written out literally, matching
// crates/buzz-sdk/src/builders.rs:1723-1729 — d tag first, emoji only when
// non-blank, text as the content, both trimmed, and NO h tag (30315 is a
// global-only kind; see crates/buzz-relay/src/handlers/ingest.rs:627).

test("a status serialises to kind 30315 on the d:general coordinate", () => {
  assert.deepEqual(buildUserStatusEvent("Vacationing", "🏖️"), {
    kind: 30315,
    content: "Vacationing",
    tags: [
      ["d", "general"],
      ["emoji", "🏖️"],
    ],
  });
});

test("no h tag is ever emitted", () => {
  const { tags } = buildUserStatusEvent("Vacationing", "🏖️");
  assert.equal(
    tags.some((tag) => tag[0] === "h"),
    false,
  );
});

test("text and emoji are trimmed", () => {
  assert.deepEqual(buildUserStatusEvent("  In a meeting  ", "  🗣️ "), {
    kind: 30315,
    content: "In a meeting",
    tags: [
      ["d", "general"],
      ["emoji", "🗣️"],
    ],
  });
});

test("a blank emoji drops the tag rather than writing an empty one", () => {
  assert.deepEqual(buildUserStatusTags("   "), [["d", "general"]]);
});

test("clearing is an empty event on the same coordinate", () => {
  assert.deepEqual(buildUserStatusEvent("", ""), {
    kind: 30315,
    content: "",
    tags: [["d", "general"]],
  });
});

// ── Parse ──────────────────────────────────────────────────────────────────

test("a status event parses to its text, emoji and timestamp", () => {
  const { pubkey, status } = parseUserStatusEvent(statusEvent());
  assert.equal(pubkey, AUTHOR);
  assert.deepEqual(status, {
    text: "Vacationing",
    emoji: "🏖️",
    updatedAt: 1_700_000_000,
    expiresAt: null,
  });
});

test("an emoji-only status is a status", () => {
  const { status } = parseUserStatusEvent(statusEvent({ content: "" }));
  assert.equal(status.text, "");
  assert.equal(status.emoji, "🏖️");
});

test("a text-only status is a status", () => {
  const { status } = parseUserStatusEvent(
    statusEvent({ tags: [["d", "general"]] }),
  );
  assert.equal(status.emoji, "");
  assert.equal(status.text, "Vacationing");
});

test("the empty event reads as NO status — that is how a clear works", () => {
  const { status } = parseUserStatusEvent(
    statusEvent({ content: "", tags: [["d", "general"]] }),
  );
  assert.equal(status, null);
});

test("a different d coordinate is not the profile status", () => {
  // NIP-38 also defines d:music; it must not overwrite the general line.
  const { status } = parseUserStatusEvent(
    statusEvent({ tags: [["d", "music"]] }),
  );
  assert.equal(status, null);
});

test("an event with no d tag is ignored", () => {
  const { status } = parseUserStatusEvent(statusEvent({ tags: [] }));
  assert.equal(status, null);
});

// ── Expiry (NIP-40 tag, honoured on read) ──────────────────────────────────

test("an expiration tag is parsed", () => {
  const { status } = parseUserStatusEvent(
    statusEvent({
      tags: [
        ["d", "general"],
        ["expiration", "1700003600"],
      ],
    }),
  );
  assert.equal(status.expiresAt, 1_700_003_600);
});

test("a non-numeric expiration is ignored rather than hiding the status", () => {
  const { status } = parseUserStatusEvent(
    statusEvent({
      tags: [
        ["d", "general"],
        ["expiration", "soon"],
      ],
    }),
  );
  assert.equal(status.expiresAt, null);
});

test("a status is expired at and after its expiration second", () => {
  const status = {
    text: "Commuting",
    emoji: "",
    updatedAt: 100,
    expiresAt: 200,
  };
  assert.equal(isStatusExpired(status, 199), false);
  assert.equal(isStatusExpired(status, 200), true);
  assert.equal(isStatusExpired(status, 201), true);
});

test("a status with no expiration never expires", () => {
  const status = {
    text: "Commuting",
    emoji: "",
    updatedAt: 100,
    expiresAt: null,
  };
  assert.equal(isStatusExpired(status, 9_999_999_999), false);
  assert.equal(activeStatus(status, 9_999_999_999), status);
});

test("activeStatus drops a lapsed status", () => {
  const status = { text: "Out sick", emoji: "🤒", updatedAt: 1, expiresAt: 50 };
  assert.equal(activeStatus(status, 49), status);
  assert.equal(activeStatus(status, 51), null);
  assert.equal(activeStatus(null, 0), null);
});

// ── Fold ───────────────────────────────────────────────────────────────────

test("the newest event wins per author, whichever order it arrives in", () => {
  const older = statusEvent({ content: "Older", created_at: 100 });
  const newer = statusEvent({ content: "Newer", created_at: 200 });
  assert.equal(
    reduceStatusEvents([older, newer], 300).get(AUTHOR).text,
    "Newer",
  );
  assert.equal(
    reduceStatusEvents([newer, older], 300).get(AUTHOR).text,
    "Newer",
  );
});

test("a newer empty event clears an older status", () => {
  const set = statusEvent({ content: "Busy", created_at: 100 });
  const cleared = statusEvent({
    content: "",
    created_at: 200,
    tags: [["d", "general"]],
  });
  const folded = reduceStatusEvents([set, cleared], 300);
  assert.equal(folded.has(AUTHOR), false);
});

test("authors are kept apart", () => {
  const mine = statusEvent({ content: "Mine", created_at: 100 });
  const theirs = statusEvent({
    pubkey: OTHER,
    content: "Theirs",
    created_at: 100,
  });
  const folded = reduceStatusEvents([mine, theirs], 300);
  assert.equal(folded.size, 2);
  assert.equal(folded.get(AUTHOR).text, "Mine");
  assert.equal(folded.get(OTHER).text, "Theirs");
});

test("an expired status is folded away", () => {
  const expiring = statusEvent({
    created_at: 100,
    tags: [
      ["d", "general"],
      ["emoji", "🚌"],
      ["expiration", "150"],
    ],
  });
  assert.equal(reduceStatusEvents([expiring], 149).size, 1);
  assert.equal(reduceStatusEvents([expiring], 151).size, 0);
});

test("the one-line label puts the emoji first", () => {
  assert.equal(
    statusLabel({
      text: "Vacationing",
      emoji: "🏖️",
      updatedAt: 1,
      expiresAt: null,
    }),
    "🏖️ Vacationing",
  );
  assert.equal(
    statusLabel({ text: "", emoji: "🏖️", updatedAt: 1, expiresAt: null }),
    "🏖️",
  );
  assert.equal(
    statusLabel({
      text: "Heads down",
      emoji: "",
      updatedAt: 1,
      expiresAt: null,
    }),
    "Heads down",
  );
});

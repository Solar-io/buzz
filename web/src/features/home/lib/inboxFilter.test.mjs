import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INBOX_FILTER_OPTIONS,
  compareInboxRows,
  filterInboxItems,
  filterInboxRows,
  inboxFilterCounts,
  inboxFilterLabel,
  inboxRowSortAt,
  matchesInboxFilter,
  matchesRowFilter,
  parseInboxFilter,
} from "./inboxFilter.ts";
import { buildInboxItems } from "./inboxItem.ts";
import { DM_CHANNEL, SELF, channels, messages } from "./inboxFixtures.mjs";

// A mixed set: a read DM, an unread mention, and a row that is BOTH a DM and
// a mention. Nothing here is uniform, so a predicate that ignores its filter
// argument fails.
const items = [
  {
    conversationId: "a",
    categories: ["mention"],
    unreadCount: 2,
    latestActivityAt: 300,
  },
  {
    conversationId: "b",
    categories: ["dm"],
    unreadCount: 0,
    latestActivityAt: 200,
  },
  {
    conversationId: "c",
    categories: ["dm", "mention"],
    unreadCount: 1,
    latestActivityAt: 100,
  },
];

// An ask of the same population: a card waiting on the viewer.
const askRow = {
  kind: "ask",
  ask: {
    id: "ask-1",
    channelId: "ch",
    channelType: "stream",
    authorPubkey: "aa".repeat(32),
    createdAt: 250,
    card: { title: "Ship?", options: [{ id: "0", label: "Yes" }] },
  },
  channelLabel: "#ch",
};
const askRowLatest = {
  kind: "ask",
  ask: { ...askRow.ask, id: "ask-2", createdAt: 400 },
  channelLabel: "#ch",
};

const rows = [...items.map((item) => ({ kind: "conversation", item })), askRow];

test("every option is a filter the predicate understands", () => {
  assert.equal(INBOX_FILTER_OPTIONS.length, 5);
  for (const option of INBOX_FILTER_OPTIONS) {
    assert.equal(parseInboxFilter(option.value), option.value);
    assert.equal(inboxFilterLabel(option.value), option.label);
  }
  assert.equal(parseInboxFilter("reminders"), "all");
  assert.equal(parseInboxFilter(undefined), "all");
});

test("each filter selects a different subset", () => {
  const ids = (filter) =>
    filterInboxItems(items, filter).map((item) => item.conversationId);
  assert.deepEqual(ids("all"), ["a", "b", "c"]);
  assert.deepEqual(ids("unread"), ["a", "c"]);
  assert.deepEqual(ids("mention"), ["a", "c"]);
  assert.deepEqual(ids("dm"), ["b", "c"]);
});

test("matchesInboxFilter is exact about a row in two categories", () => {
  const both = items[2];
  assert.equal(matchesInboxFilter(both, "mention"), true);
  assert.equal(matchesInboxFilter(both, "dm"), true);
  const mentionOnly = items[0];
  assert.equal(matchesInboxFilter(mentionOnly, "dm"), false);
  const readDm = items[1];
  assert.equal(matchesInboxFilter(readDm, "unread"), false);
});

test("asks show under all/asks/unread, and dm/mention classify by where the ask lives", () => {
  for (const filter of ["all", "asks", "unread"]) {
    assert.equal(matchesRowFilter(askRow, filter), true, filter);
  }
  // A channel ask (always p-tagged) surfaces under Mentions, never DMs.
  assert.equal(matchesRowFilter(askRow, "mention"), true);
  assert.equal(matchesRowFilter(askRow, "dm"), false);
  // A DM ask surfaces under DMs, never Mentions.
  const dmAskRow = {
    kind: "ask",
    ask: { ...askRow.ask, id: "ask-dm", channelType: "dm" },
    channelLabel: "someone",
  };
  assert.equal(matchesRowFilter(dmAskRow, "dm"), true);
  assert.equal(matchesRowFilter(dmAskRow, "mention"), false);
  // And no conversation ever appears under the asks filter.
  assert.equal(matchesRowFilter(rows[0], "asks"), false);
  assert.deepEqual(
    filterInboxRows(rows, "asks").map((row) => row.kind),
    ["ask"],
  );
});

test("compareInboxRows pins asks above conversations, newest first within each", () => {
  // The newest thing in this set is a CONVERSATION (400) and the ask is
  // older (250): the pin must still put the ask first — this is exactly the
  // "one unread item I can't find" shape when the badge counts a buried ask.
  const mixed = [rows[0], askRowLatest, rows[2], askRow];
  const sorted = [...mixed].sort(compareInboxRows);
  assert.deepEqual(
    sorted.map((row) => row.kind),
    ["ask", "ask", "conversation", "conversation"],
  );
  // Newest-first within the asks…
  assert.equal(sorted[0].ask.id, "ask-2");
  assert.equal(sorted[1].ask.id, "ask-1");
  // …and within the conversations.
  assert.deepEqual(
    sorted.slice(2).map((row) => row.item.conversationId),
    ["a", "c"],
  );
  // Recency alone would have interleaved them — the pin is the rule under
  // test, so prove the plain-recency order differs.
  const byRecency = [...mixed].sort(
    (a, b) => inboxRowSortAt(b) - inboxRowSortAt(a),
  );
  assert.notDeepEqual(
    sorted.map((row) => (row.kind === "ask" ? row.ask.id : row.item.conversationId)),
    byRecency.map((row) => (row.kind === "ask" ? row.ask.id : row.item.conversationId)),
  );
});

test("counts are per filter, not per row", () => {
  // askRow is a stream ask, so it lifts "mention" (where it now appears)
  // and leaves "dm" untouched.
  assert.deepEqual(inboxFilterCounts(rows), {
    all: 4,
    unread: 3,
    asks: 1,
    mention: 3,
    dm: 2,
  });
});

test("filters narrow real inbox rows", () => {
  const built = buildInboxItems({
    messages,
    channels,
    selfPubkey: SELF,
    isRead: () => false,
  });
  assert.equal(built.length, 3);
  assert.deepEqual(
    filterInboxItems(built, "dm").map((item) => item.conversationId),
    [`dm:${DM_CHANNEL}`],
  );
  assert.deepEqual(
    filterInboxItems(built, "mention").map((item) => item.conversationId),
    ["mention-general", "mention-design"],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INBOX_FILTER_OPTIONS,
  filterInboxItems,
  inboxFilterCounts,
  inboxFilterLabel,
  matchesInboxFilter,
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
  },
  {
    conversationId: "b",
    categories: ["dm"],
    unreadCount: 0,
  },
  {
    conversationId: "c",
    categories: ["dm", "mention"],
    unreadCount: 1,
  },
];

test("every option is a filter the predicate understands", () => {
  assert.equal(INBOX_FILTER_OPTIONS.length, 4);
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

test("counts are per filter, not per row", () => {
  assert.deepEqual(inboxFilterCounts(items), {
    all: 3,
    unread: 2,
    mention: 2,
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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_INBOX_READ_STATE,
  INBOX_READ_MAX_ENTRIES,
  inboxReadPredicate,
  isInboxMessageRead,
  markInboxMessagesRead,
  markInboxMessagesUnread,
  pruneInboxMarkers,
} from "./inboxReadState.ts";
import { buildInboxItems } from "./inboxItem.ts";
import {
  DM_CHANNEL,
  GENERAL,
  SELF,
  channels,
  message,
  messages,
} from "./inboxFixtures.mjs";

/**
 * The fixture that makes this suite discriminating: the channel marker sits
 * BETWEEN two #general messages, so one is read and one is not, in the SAME
 * channel. A derivation that always answers "read", always answers "unread",
 * or consults only one of the two sources cannot satisfy both assertions.
 */
const channelRead = { [GENERAL]: 1_000 };
const older = message({ id: "older", channelId: GENERAL, createdAt: 900 });
const newer = message({ id: "newer", channelId: GENERAL, createdAt: 1_100 });
const exactly = message({
  id: "exactly",
  channelId: GENERAL,
  createdAt: 1_000,
});
const otherChannel = message({ id: "dm", channelId: DM_CHANNEL, createdAt: 5 });
const empty = EMPTY_INBOX_READ_STATE;

test("the channel marker alone decides when the overlay is empty", () => {
  assert.equal(isInboxMessageRead(older, channelRead, empty), true);
  assert.equal(isInboxMessageRead(newer, channelRead, empty), false);
  // The marker is inclusive: "seen up to and including this timestamp".
  assert.equal(isInboxMessageRead(exactly, channelRead, empty), true);
});

test("a channel with no marker at all has nothing read", () => {
  assert.equal(isInboxMessageRead(otherChannel, channelRead, empty), false);
  assert.equal(isInboxMessageRead(otherChannel, {}, empty), false);
});

test("an explicit read marker beats a channel marker that has not reached it", () => {
  assert.equal(isInboxMessageRead(newer, channelRead, empty), false);
  const read = markInboxMessagesRead(empty, [newer]);
  assert.equal(isInboxMessageRead(newer, channelRead, read), true);
  // ...and a marker for a DIFFERENT message must not leak across.
  assert.equal(
    isInboxMessageRead(
      newer,
      channelRead,
      markInboxMessagesRead(empty, [older]),
    ),
    false,
  );
});

test("an explicit unread marker beats a channel marker that has passed it", () => {
  assert.equal(isInboxMessageRead(older, channelRead, empty), true);
  const unread = markInboxMessagesUnread(empty, [older]);
  assert.equal(isInboxMessageRead(older, channelRead, unread), false);
});

test("the two directions are mutually exclusive", () => {
  const read = markInboxMessagesRead(empty, [newer]);
  assert.equal(isInboxMessageRead(newer, channelRead, read), true);
  const unread = markInboxMessagesUnread(read, [newer]);
  assert.equal(unread.read.newer, undefined);
  assert.equal(unread.unread.newer, 1_100);
  assert.equal(isInboxMessageRead(newer, channelRead, unread), false);
  const readAgain = markInboxMessagesRead(unread, [newer]);
  assert.equal(readAgain.unread.newer, undefined);
  assert.equal(isInboxMessageRead(newer, channelRead, readAgain), true);
});

test("marking is a no-op when the marker is already where it should be", () => {
  const read = markInboxMessagesRead(empty, [newer]);
  assert.equal(markInboxMessagesRead(read, [newer]), read);
  const unread = markInboxMessagesUnread(empty, [older]);
  assert.equal(markInboxMessagesUnread(unread, [older]), unread);
});

test("markers are pruned newest-first at the cap", () => {
  const oversized = {};
  for (let i = 0; i < INBOX_READ_MAX_ENTRIES + 25; i += 1) {
    oversized[`m${i}`] = i;
  }
  const pruned = pruneInboxMarkers(oversized);
  assert.equal(Object.keys(pruned).length, INBOX_READ_MAX_ENTRIES);
  assert.ok("m524" in pruned, "the newest marker survives");
  assert.ok(!("m0" in pruned), "the oldest marker is dropped");
});

test("unread counts fall through the predicate into the inbox rows", () => {
  const items = buildInboxItems({
    messages,
    channels,
    selfPubkey: SELF,
    // Marker between the two #general messages: the root (1000) is read,
    // the reply (1200) is not. The DM (1500) has no marker at all.
    isRead: inboxReadPredicate({ [GENERAL]: 1_000 }, empty),
  });
  const general = items.find(
    (item) => item.conversationId === "mention-general",
  );
  assert.equal(general.unreadCount, 1);
  assert.equal(general.message.id, "reply-general");

  const dm = items.find((item) => item.conversationId === `dm:${DM_CHANNEL}`);
  assert.equal(dm.unreadCount, 1);

  // Clearing that one reply must zero its row WITHOUT touching the DM row —
  // the failure the two-source design exists to avoid.
  const cleared = buildInboxItems({
    messages,
    channels,
    selfPubkey: SELF,
    isRead: inboxReadPredicate(
      { [GENERAL]: 1_000 },
      markInboxMessagesRead(empty, [{ id: "reply-general", createdAt: 1_200 }]),
    ),
  });
  assert.equal(
    cleared.find((item) => item.conversationId === "mention-general")
      .unreadCount,
    0,
  );
  assert.equal(
    cleared.find((item) => item.conversationId === `dm:${DM_CHANNEL}`)
      .unreadCount,
    1,
  );
});

test("marking a conversation unread again restores its row count", () => {
  const readEverything = { [GENERAL]: 9_999, [DM_CHANNEL]: 9_999 };
  const allRead = buildInboxItems({
    messages,
    channels,
    selfPubkey: SELF,
    isRead: inboxReadPredicate(readEverything, empty),
  });
  assert.equal(
    allRead.find((item) => item.conversationId === "mention-general")
      .unreadCount,
    0,
  );

  const deferred = buildInboxItems({
    messages,
    channels,
    selfPubkey: SELF,
    isRead: inboxReadPredicate(
      readEverything,
      markInboxMessagesUnread(empty, [
        { id: "mention-general", createdAt: 1_000 },
        { id: "reply-general", createdAt: 1_200 },
      ]),
    ),
  });
  const row = deferred.find(
    (item) => item.conversationId === "mention-general",
  );
  assert.equal(row.unreadCount, 2);
  assert.equal(row.message.id, "mention-general");
  // The DM row was read by its channel marker and stays read.
  assert.equal(
    deferred.find((item) => item.conversationId === `dm:${DM_CHANNEL}`)
      .unreadCount,
    0,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInboxItems,
  inboxCategories,
  inboxConversationId,
  inboxItemChannelLabel,
  inboxUnreadTotal,
} from "./inboxItem.ts";
import {
  ALICE,
  BOB,
  DESIGN,
  DM_CHANNEL,
  GENERAL,
  SELF,
  channels,
  message,
  messages,
  nothingRead,
} from "./inboxFixtures.mjs";

const build = (overrides = {}) =>
  buildInboxItems({
    messages,
    channels,
    selfPubkey: SELF,
    isRead: nothingRead,
    ...overrides,
  });

test("a DM collapses to its channel, a thread to its NIP-10 root", () => {
  assert.equal(
    inboxConversationId({ id: "m1", channelId: DM_CHANNEL }, "dm"),
    `dm:${DM_CHANNEL}`,
  );
  assert.equal(
    inboxConversationId(
      { id: "reply", channelId: GENERAL, rootId: "root-1", replyToId: "mid" },
      "stream",
    ),
    "root-1",
  );
  assert.equal(
    inboxConversationId(
      { id: "reply", channelId: GENERAL, rootId: null, replyToId: "parent-1" },
      "stream",
    ),
    "parent-1",
  );
  assert.equal(
    inboxConversationId(
      { id: "top", channelId: GENERAL, rootId: null, replyToId: null },
      "stream",
    ),
    "top",
  );
});

test("categories name a DM, a mention, and both at once", () => {
  assert.deepEqual(inboxCategories({ mentionPubkeys: [] }, "dm", SELF), ["dm"]);
  assert.deepEqual(
    inboxCategories({ mentionPubkeys: [SELF] }, "stream", SELF),
    ["mention"],
  );
  assert.deepEqual(inboxCategories({ mentionPubkeys: [SELF] }, "dm", SELF), [
    "dm",
    "mention",
  ]);
  assert.deepEqual(
    inboxCategories({ mentionPubkeys: [ALICE] }, "stream", SELF),
    [],
  );
});

test("buildInboxItems groups a thread into one row and keeps every message", () => {
  const items = build();
  const general = items.find(
    (item) => item.conversationId === "mention-general",
  );
  assert.ok(general, "the #general thread should produce a row");
  assert.equal(general.messages.length, 2);
  assert.deepEqual(
    general.messages.map((entry) => entry.id),
    ["mention-general", "reply-general"],
  );
  assert.equal(general.latestActivityAt, 1_200);
  assert.equal(general.channelName, "general");
  assert.equal(inboxItemChannelLabel(general), "#general");
});

test("buildInboxItems drops own messages, non-mentions and deleted rows", () => {
  const items = build();
  const ids = items.flatMap((item) => item.messages.map((entry) => entry.id));
  assert.ok(!ids.includes("own-message"), "own sends are not inbox items");
  assert.ok(!ids.includes("chatter"), "an unaddressed channel message is not");
  assert.ok(ids.includes("dm-1"), "someone else's DM message is");

  const withDeleted = build({
    messages: [
      ...messages,
      message({
        id: "dm-2",
        channelId: DM_CHANNEL,
        createdAt: 1_700,
        deleted: true,
      }),
    ],
  });
  const dm = withDeleted.find(
    (item) => item.conversationId === `dm:${DM_CHANNEL}`,
  );
  assert.deepEqual(
    dm.messages.map((entry) => entry.id),
    ["dm-1"],
  );
});

test("rows are ordered newest activity first", () => {
  const items = build();
  assert.deepEqual(
    items.map((item) => item.conversationId),
    [`dm:${DM_CHANNEL}`, "mention-general", "mention-design"],
  );
  assert.deepEqual(
    items.map((item) => item.latestActivityAt),
    [1_500, 1_200, 900],
  );
});

test("the representative message is the OLDEST unread, and the newest when all are read", () => {
  const allUnread = build();
  const general = allUnread.find(
    (item) => item.conversationId === "mention-general",
  );
  assert.equal(general.message.id, "mention-general");
  assert.equal(general.unreadCount, 2);

  // Only the thread root has been read: the row should now point at the reply.
  const rootRead = build({ isRead: (entry) => entry.id === "mention-general" });
  const partial = rootRead.find(
    (item) => item.conversationId === "mention-general",
  );
  assert.equal(partial.message.id, "reply-general");
  assert.equal(partial.unreadCount, 1);

  const allRead = build({ isRead: () => true });
  const done = allRead.find(
    (item) => item.conversationId === "mention-general",
  );
  assert.equal(done.message.id, "reply-general");
  assert.equal(done.unreadCount, 0);
});

test("duplicate deliveries do not double-count a conversation", () => {
  const items = build({ messages: [...messages, ...messages] });
  const general = items.find(
    (item) => item.conversationId === "mention-general",
  );
  assert.equal(general.messages.length, 2);
  assert.equal(general.unreadCount, 2);
});

test("a message in an unknown channel still produces a row", () => {
  const orphanChannel = "44444444-4444-4444-8444-444444444444";
  const items = build({
    messages: [
      message({
        id: "orphan",
        channelId: orphanChannel,
        authorPubkey: BOB,
        createdAt: 2_000,
        mentionPubkeys: [SELF],
      }),
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].channelId, orphanChannel);
  assert.equal(items[0].channelName, orphanChannel);
});

test("no self pubkey means no inbox", () => {
  assert.deepEqual(build({ selfPubkey: null }), []);
});

test("inboxUnreadTotal sums the rows", () => {
  const items = build();
  assert.equal(items.length, 3);
  assert.equal(inboxUnreadTotal(items), 4);
  assert.equal(inboxUnreadTotal(build({ isRead: () => true })), 0);
});

test("the design mention lands in its own channel row", () => {
  const items = build();
  const design = items.find((item) => item.conversationId === "mention-design");
  assert.equal(design.channelId, DESIGN);
  assert.equal(design.channelName, "design");
  assert.deepEqual(design.categories, ["mention"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INBOX_GROUPING_WINDOW_SECONDS,
  inboxContextGrouped,
  inboxThreadContext,
  inboxThreadRootId,
} from "./inboxThread.ts";
import { buildInboxItems } from "./inboxItem.ts";
import {
  ALICE,
  BOB,
  DM_CHANNEL,
  GENERAL,
  SELF,
  channels,
  message,
  messages,
} from "./inboxFixtures.mjs";

const items = buildInboxItems({
  messages,
  channels,
  selfPubkey: SELF,
  isRead: () => false,
});
const generalItem = items.find(
  (item) => item.conversationId === "mention-general",
);
const dmItem = items.find((item) => item.conversationId === `dm:${DM_CHANNEL}`);

/** A live channel buffer holding more than the thread under test. */
const buffer = [
  message({ id: "mention-general", createdAt: 1_000, mentionPubkeys: [SELF] }),
  message({
    id: "reply-general",
    authorPubkey: BOB,
    createdAt: 1_200,
    rootId: "mention-general",
    replyToId: "mention-general",
  }),
  message({
    id: "later-reply",
    authorPubkey: ALICE,
    createdAt: 1_400,
    rootId: "mention-general",
    replyToId: "reply-general",
  }),
  message({ id: "chatter", authorPubkey: BOB, createdAt: 1_300 }),
  message({ id: "other-thread", createdAt: 1_350, rootId: "somewhere-else" }),
];

test("the thread root is the NIP-10 root, else the parent, else the message", () => {
  assert.equal(inboxThreadRootId(generalItem), "mention-general");
});

test("a channel row shows its thread and nothing else from the channel", () => {
  const context = inboxThreadContext(generalItem, buffer);
  assert.deepEqual(
    context.map((entry) => entry.id),
    ["mention-general", "reply-general", "later-reply"],
  );
  assert.ok(
    !context.some((entry) => entry.id === "chatter"),
    "unrelated channel chatter must not leak into the thread",
  );
  assert.ok(
    !context.some((entry) => entry.id === "other-thread"),
    "another thread's replies must not leak in either",
  );
});

test("a DM row shows the channel tail, because the channel IS the conversation", () => {
  const dmBuffer = [
    message({ id: "dm-0", channelId: DM_CHANNEL, createdAt: 1_400 }),
    message({ id: "dm-1", channelId: DM_CHANNEL, createdAt: 1_500 }),
    message({
      id: "dm-2",
      channelId: DM_CHANNEL,
      authorPubkey: SELF,
      createdAt: 1_600,
    }),
    message({ id: "elsewhere", channelId: GENERAL, createdAt: 1_650 }),
  ];
  const context = inboxThreadContext(dmItem, dmBuffer);
  assert.deepEqual(
    context.map((entry) => entry.id),
    ["dm-0", "dm-1", "dm-2"],
  );
});

test("the row's own messages render before the live buffer arrives", () => {
  const context = inboxThreadContext(generalItem, []);
  assert.deepEqual(
    context.map((entry) => entry.id),
    ["mention-general", "reply-general"],
  );
});

test("deleted messages are not context", () => {
  const context = inboxThreadContext(generalItem, [
    ...buffer.slice(0, 2),
    message({
      id: "later-reply",
      createdAt: 1_400,
      rootId: "mention-general",
      deleted: true,
    }),
  ]);
  assert.deepEqual(
    context.map((entry) => entry.id),
    ["mention-general", "reply-general"],
  );
});

test("the context is capped to the newest N of the thread", () => {
  const long = Array.from({ length: 12 }, (_, index) =>
    message({
      id: `r${index}`,
      createdAt: 2_000 + index,
      rootId: "mention-general",
      replyToId: "mention-general",
    }),
  );
  const context = inboxThreadContext(generalItem, [...buffer, ...long], 5);
  const fromBuffer = context.filter((entry) => /^r\d+$/.test(entry.id));
  assert.equal(fromBuffer.length, 5);
  assert.deepEqual(
    fromBuffer.map((entry) => entry.id),
    ["r7", "r8", "r9", "r10", "r11"],
  );
});

test("grouping needs the same author inside the window", () => {
  const first = message({ id: "g1", authorPubkey: ALICE, createdAt: 1_000 });
  const sameSoon = message({ id: "g2", authorPubkey: ALICE, createdAt: 1_100 });
  const sameLate = message({
    id: "g3",
    authorPubkey: ALICE,
    createdAt: 1_000 + INBOX_GROUPING_WINDOW_SECONDS,
  });
  const otherAuthor = message({
    id: "g4",
    authorPubkey: BOB,
    createdAt: 1_010,
  });
  assert.equal(inboxContextGrouped(first, undefined), false);
  assert.equal(inboxContextGrouped(sameSoon, first), true);
  assert.equal(inboxContextGrouped(sameLate, first), false);
  assert.equal(inboxContextGrouped(otherAuthor, first), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelIdOf,
  classifyMessage,
  taggedPubkeys,
} from "./classifyMessage.ts";

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);
const CHANNEL = "11111111-1111-1111-1111-111111111111";
const DM = "22222222-2222-2222-2222-222222222222";

function event(overrides = {}) {
  return {
    id: "e1",
    pubkey: OTHER,
    content: "hello",
    created_at: 1000,
    tags: [["h", CHANNEL]],
    ...overrides,
  };
}

const context = {
  selfPubkey: SELF,
  activeChannelId: null,
  mutedChannelIds: [],
  dmChannelIds: [DM],
};

test("the channel comes from the h tag, never from an e tag", () => {
  assert.equal(
    channelIdOf(
      event({
        tags: [
          ["e", "not-a-channel", "", "root"],
          ["h", CHANNEL],
        ],
      }),
    ),
    CHANNEL,
  );
  assert.equal(channelIdOf(event({ tags: [["e", "root-id"]] })), null);
});

test("p tags are collected in order", () => {
  assert.deepEqual(
    taggedPubkeys(
      event({
        tags: [
          ["h", CHANNEL],
          ["p", SELF],
          ["p", OTHER],
        ],
      }),
    ),
    [SELF, OTHER],
  );
});

test("a p tag naming you is a mention", () => {
  const { message } = classifyMessage(
    event({
      tags: [
        ["h", CHANNEL],
        ["p", SELF],
      ],
    }),
    context,
  );
  assert.equal(message.mentionsSelf, true);
  assert.equal(message.fromSelf, false);
});

test("a p tag naming somebody else is not a mention", () => {
  const { message } = classifyMessage(
    event({
      tags: [
        ["h", CHANNEL],
        ["p", OTHER],
      ],
    }),
    context,
  );
  assert.equal(message.mentionsSelf, false);
});

test("your own message is recognised as yours", () => {
  const { message } = classifyMessage(event({ pubkey: SELF }), context);
  assert.equal(message.fromSelf, true);
});

test("a DM channel id makes the message a DM", () => {
  const { channelId, message } = classifyMessage(
    event({ tags: [["h", DM]] }),
    context,
  );
  assert.equal(channelId, DM);
  assert.equal(message.isDm, true);
});

test("a muted channel is flagged", () => {
  const { message } = classifyMessage(event(), {
    ...context,
    mutedChannelIds: [CHANNEL],
  });
  assert.equal(message.channelMuted, true);
});

test("the open channel is flagged", () => {
  const open = classifyMessage(event(), {
    ...context,
    activeChannelId: CHANNEL,
  });
  assert.equal(open.message.isActiveChannel, true);
  const elsewhere = classifyMessage(event(), {
    ...context,
    activeChannelId: DM,
  });
  assert.equal(elsewhere.message.isActiveChannel, false);
});

test("an event with no h tag is treated as muted, not as a notification", () => {
  const { channelId, message } = classifyMessage(
    event({ tags: [["p", SELF]] }),
    context,
  );
  assert.equal(channelId, null);
  assert.equal(message.channelMuted, true);
});

test("with no signed-in key nothing is yours and nothing mentions you", () => {
  const { message } = classifyMessage(
    event({
      pubkey: SELF,
      tags: [
        ["h", CHANNEL],
        ["p", SELF],
      ],
    }),
    { ...context, selfPubkey: null },
  );
  assert.equal(message.fromSelf, false);
  assert.equal(message.mentionsSelf, false);
});

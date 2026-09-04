/**
 * Shared fixtures for the inbox suites.
 *
 * Written so the assertions can FAIL: every discriminating field differs
 * across the fixture set (two channels, one DM; a read message and an unread
 * one in the SAME channel; a mention and a non-mention; two conversations with
 * different newest-activity times). A fixture where every message looks alike
 * would pass under any mutation, which is the failure mode this file exists to
 * avoid.
 */

export const SELF = "aa".repeat(32);
export const ALICE = "bb".repeat(32);
export const BOB = "cc".repeat(32);

export const GENERAL = "11111111-1111-4111-8111-111111111111";
export const DESIGN = "22222222-2222-4222-8222-222222222222";
export const DM_CHANNEL = "33333333-3333-4333-8333-333333333333";

export const channels = [
  { id: GENERAL, name: "general", type: "stream" },
  { id: DESIGN, name: "design", type: "stream" },
  { id: DM_CHANNEL, name: "Alice", type: "dm" },
];

/** Build a TimelineMessage-shaped record. */
export function message(overrides) {
  return {
    id: "id-0",
    channelId: GENERAL,
    authorPubkey: ALICE,
    createdAt: 1_000,
    content: "hello",
    kind: 9,
    rootId: null,
    replyToId: null,
    mentionPubkeys: [],
    imetaByUrl: new Map(),
    linkPreviews: [],
    edited: false,
    deleted: false,
    ...overrides,
  };
}

/**
 * A mention in #general (root of its own thread), one reply to it, a mention
 * in #design, a DM message, and one message addressed to nobody.
 */
export const messages = [
  message({
    id: "mention-general",
    channelId: GENERAL,
    createdAt: 1_000,
    content: "hey @self can you look",
    mentionPubkeys: [SELF],
  }),
  message({
    id: "reply-general",
    channelId: GENERAL,
    authorPubkey: BOB,
    createdAt: 1_200,
    content: "seconded",
    rootId: "mention-general",
    replyToId: "mention-general",
    mentionPubkeys: [SELF],
  }),
  message({
    id: "mention-design",
    channelId: DESIGN,
    createdAt: 900,
    content: "@self design review?",
    mentionPubkeys: [SELF],
  }),
  message({
    id: "dm-1",
    channelId: DM_CHANNEL,
    createdAt: 1_500,
    content: "are you around",
  }),
  message({
    id: "chatter",
    channelId: GENERAL,
    authorPubkey: BOB,
    createdAt: 1_300,
    content: "unrelated",
  }),
  message({
    id: "own-message",
    channelId: DM_CHANNEL,
    authorPubkey: SELF,
    createdAt: 1_600,
    content: "yes, one sec",
  }),
];

/** Nothing read at all. */
export const nothingRead = () => false;

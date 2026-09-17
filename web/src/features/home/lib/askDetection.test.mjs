import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asksBadgeCount,
  answeredByMe,
  askForMe,
  extractAsks,
  unansweredAsks,
} from "./askDetection.ts";
import { message } from "./inboxFixtures.mjs";

const SELF = "aa".repeat(32);
const ALICE = "bb".repeat(32);
const BOB = "cc".repeat(32);

const GENERAL = "11111111-1111-4111-8111-111111111111";
const DM_TWO = "33333333-3333-4333-8333-333333333333";
const DM_GROUP = "44444444-4444-4444-8444-444444444444";

const channels = [
  { id: GENERAL, type: "stream", participantCount: 5 },
  { id: DM_TWO, type: "dm", participantCount: 2 },
  { id: DM_GROUP, type: "dm", participantCount: 3 },
];

const card = {
  title: "Ship the fix?",
  options: [
    { id: "0", label: "Yes", recommended: true },
    { id: "1", label: "No" },
  ],
};

function cardMessage(overrides = {}) {
  return message({
    id: "card-1",
    channelId: GENERAL,
    authorPubkey: ALICE,
    createdAt: 1_000,
    content: "**Ship the fix?**",
    card,
    ...overrides,
  });
}

// ---- askForMe ------------------------------------------------------------

test("askForMe.ignores own cards", () => {
  // The viewer's OWN card, even one that p-tags the viewer (mentioning
  // yourself is a real pattern: "asking the room, cc me"). It is not an ask.
  const own = cardMessage({
    authorPubkey: SELF,
    mentionPubkeys: [SELF],
  });
  assert.equal(askForMe(own, SELF, "stream", 5), false);
  // Symmetric control: the same card from someone else IS an ask.
  const theirs = cardMessage({ authorPubkey: ALICE, mentionPubkeys: [SELF] });
  assert.equal(askForMe(theirs, SELF, "stream", 5), true);
});

test("askForMe.dm card without p-tag counts in 2-party dm", () => {
  // The leniency case: agents asking inside a 1:1 DM omit --mention because
  // the askee is unambiguous.
  const lenient = cardMessage({
    channelId: DM_TWO,
    mentionPubkeys: [],
  });
  assert.equal(askForMe(lenient, SELF, "dm", 2), true);
});

test("askForMe refuses group-DM and channel cards that do not p-tag me", () => {
  // Three-party DM: the askee is NOT unambiguous, so the leniency must not
  // stretch. Same card in a plain channel: same refusal.
  const groupCard = cardMessage({ channelId: DM_GROUP, mentionPubkeys: [] });
  assert.equal(askForMe(groupCard, SELF, "dm", 3), false);
  const channelCard = cardMessage({ channelId: GENERAL, mentionPubkeys: [] });
  assert.equal(askForMe(channelCard, SELF, "stream", 5), false);
  // And the same group card WITH my p-tag is an ask — the p-tag is what
  // carries it, not the channel type.
  assert.equal(
    askForMe(
      cardMessage({ channelId: DM_GROUP, mentionPubkeys: [SELF] }),
      SELF,
      "dm",
      3,
    ),
    true,
  );
});

test("askForMe refuses cards addressed to somebody else", () => {
  const forBob = cardMessage({ mentionPubkeys: [BOB] });
  assert.equal(askForMe(forBob, SELF, "stream", 5), false);
});

test("askForMe refuses non-card messages outright", () => {
  const plain = message({
    authorPubkey: ALICE,
    mentionPubkeys: [SELF],
    card: null,
  });
  assert.equal(askForMe(plain, SELF, "stream", 5), false);
  // A malformed card tag parses to null upstream (messageBuffer) — same
  // refusal, it renders as plain text everywhere else too.
  const broken = cardMessage({ card: null });
  assert.equal(askForMe(broken, SELF, "stream", 5), false);
});

// ---- answeredByMe ---------------------------------------------------------

test("answeredByMe accepts my direct reply to the card", () => {
  const direct = message({
    kind: 9,
    authorPubkey: SELF,
    replyToId: "card-1",
    rootId: null,
  });
  assert.equal(answeredByMe(direct, "card-1", SELF), true);
  // A card that is itself a thread reply: my answer carries the thread root
  // AND the card — still a direct reply to the card.
  const nested = message({
    kind: 9,
    authorPubkey: SELF,
    rootId: "thread-root",
    replyToId: "card-1",
  });
  assert.equal(answeredByMe(nested, "card-1", SELF), true);
});

test("answeredByMe.deep thread reply does not clear", () => {
  // My reply to a SIBLING under the same thread root names the sibling, not
  // the card. The thread root being the card is not enough — only a reply
  // TO the card is an answer.
  const siblingReply = message({
    kind: 9,
    authorPubkey: SELF,
    rootId: "card-1",
    replyToId: "sibling-9",
  });
  assert.equal(answeredByMe(siblingReply, "card-1", SELF), false);
});

test("answeredByMe refuses other people's answers and non-messages", () => {
  const theirs = message({
    kind: 9,
    authorPubkey: BOB,
    replyToId: "card-1",
    rootId: null,
  });
  assert.equal(answeredByMe(theirs, "card-1", SELF), false);
  // A broadcast (40002) mentioning the card id is not an answer either.
  const broadcast = message({
    kind: 40002,
    authorPubkey: SELF,
    replyToId: "card-1",
    rootId: null,
  });
  assert.equal(answeredByMe(broadcast, "card-1", SELF), false);
});

// ---- extractAsks -----------------------------------------------------------

test("extractAsks pulls only asks-for-me, newest first", () => {
  const feed = [
    cardMessage({
      id: "old-ask",
      createdAt: 900,
      channelId: GENERAL,
      mentionPubkeys: [SELF],
    }),
    cardMessage({
      id: "new-ask",
      createdAt: 1_100,
      channelId: DM_TWO,
      mentionPubkeys: [],
    }),
    // Not asks: my own card, a card for Bob, a non-card mention.
    cardMessage({ id: "own", authorPubkey: SELF, mentionPubkeys: [SELF] }),
    cardMessage({ id: "for-bob", mentionPubkeys: [BOB] }),
    message({ id: "plain", authorPubkey: ALICE, mentionPubkeys: [SELF] }),
    cardMessage({
      id: "group-no-tag",
      channelId: DM_GROUP,
      mentionPubkeys: [],
    }),
  ];
  const asks = extractAsks(feed, SELF, channels);
  assert.deepEqual(
    asks.map((ask) => ask.id),
    ["new-ask", "old-ask"],
  );
  assert.equal(asks[0].channelType, "dm");
  assert.equal(asks[0].card.title, "Ship the fix?");
  assert.equal(asks[1].channelType, "stream");
});

test("extractAsks is conservative about an unknown channel", () => {
  // A card in a channel the shell has not metadata for: no DM leniency can
  // apply (we cannot know it is a 2-party DM), so only a p-tag counts.
  const tagged = cardMessage({
    channelId: "unknown-ch",
    mentionPubkeys: [SELF],
  });
  const untagged = cardMessage({ channelId: "unknown-ch", mentionPubkeys: [] });
  const asks = extractAsks(feed([tagged, untagged]), SELF, channels);
  assert.deepEqual(
    asks.map((ask) => ask.id),
    [tagged.id],
  );
});

test("extractAsks yields nothing without a viewer key", () => {
  assert.deepEqual(extractAsks(feed([cardMessage()]), null, channels), []);
});

function feed(messages) {
  return messages;
}

// ---- unansweredAsks / asksBadgeCount --------------------------------------

const askItems = [
  {
    id: "a",
    channelId: GENERAL,
    channelType: "stream",
    authorPubkey: ALICE,
    createdAt: 3,
    card,
  },
  {
    id: "b",
    channelId: GENERAL,
    channelType: "stream",
    authorPubkey: ALICE,
    createdAt: 2,
    card,
  },
  {
    id: "c",
    channelId: DM_TWO,
    channelType: "dm",
    authorPubkey: BOB,
    createdAt: 1,
    card,
  },
];

test("unansweredAsks.excludes answered cards", () => {
  const answered = { b: "answer-for-b" };
  const waiting = unansweredAsks(askItems, answered);
  assert.deepEqual(
    waiting.map((ask) => ask.id),
    ["a", "c"],
  );
});

test("asksBadgeCount.counts only unanswered", () => {
  // Three asks, one answered: the badge is 2. Counting the answered one
  // would leave a badge that never dies.
  assert.equal(asksBadgeCount(askItems, { b: "answer-for-b" }), 2);
  assert.equal(asksBadgeCount(askItems, {}), 3);
  assert.equal(asksBadgeCount(askItems, { a: "x", b: "y", c: "z" }), 0);
});

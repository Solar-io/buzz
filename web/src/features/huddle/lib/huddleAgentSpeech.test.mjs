import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botPubkeysFromMemberEvent,
  classifySpeakableAgentText,
  createOrderedSpeaker,
  GROUP_MEMBERS_KIND,
  huddleAgentSpeechFilter,
  huddleMemberSnapshotFilter,
  shouldSpeakLocally,
  SPEAKABLE_MESSAGE_KINDS,
  SPEECH_REPLAY_WINDOW_SECONDS,
  textWithoutAttachments,
} from "./huddleAgentSpeech.ts";

const AGENT = "a".repeat(64);
const OTHER_AGENT = "b".repeat(64);
const HUMAN = "c".repeat(64);
const CHANNEL = "eph-1";
const agents = new Set([AGENT, OTHER_AGENT]);

function message(overrides = {}) {
  return {
    id: "e".repeat(64),
    kind: 40002,
    pubkey: AGENT,
    content: "Ready when you are.",
    tags: [["h", CHANNEL]],
    ...overrides,
  };
}

test("the speakable kinds are the message kinds, hardcoded", () => {
  assert.deepEqual(SPEAKABLE_MESSAGE_KINDS, [9, 40002]);
  assert.equal(GROUP_MEMBERS_KIND, 39002);
  assert.equal(SPEECH_REPLAY_WINDOW_SECONDS, 5);
});

test("an agent message in this channel is speakable", () => {
  const result = classifySpeakableAgentText(message(), agents, HUMAN, CHANNEL);
  assert.equal(result.reason, null);
  assert.equal(result.text, "Ready when you are.");
});

test("kind 9 is speakable as well as kind 40002", () => {
  const result = classifySpeakableAgentText(
    message({ kind: 9 }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, null);
});

test("a message edit is not spoken", () => {
  // 40003 is KIND_STREAM_MESSAGE_EDIT — a real neighbouring kind that shares
  // the channel, not an invented one.
  const result = classifySpeakableAgentText(
    message({ kind: 40003 }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "unsupported_kind");
  assert.equal(result.text, null);
});

test("a message for a DIFFERENT channel is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ tags: [["h", "eph-2"]] }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "h_tag_mismatch");
});

test("a human's message is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ pubkey: HUMAN }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "author_not_agent");
});

test("membership is fail-closed: an empty agent set speaks nothing", () => {
  const result = classifySpeakableAgentText(
    message(),
    new Set(),
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "author_not_agent");
});

test("your own message is never read back to you", () => {
  // selfPubkey === the author, and the author IS a known agent — so only the
  // self-check can reject this. Discriminating by construction.
  const result = classifySpeakableAgentText(message(), agents, AGENT, CHANNEL);
  assert.equal(result.reason, "self_authored");
});

test("self matching is case-insensitive", () => {
  const result = classifySpeakableAgentText(
    message({ pubkey: AGENT.toUpperCase() }),
    agents,
    AGENT,
    CHANNEL,
  );
  assert.equal(result.reason, "self_authored");
});

test("an empty message is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ content: "   \n  " }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "empty_or_system");
});

test("a [System] notice is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ content: "[System] agent restarted" }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "empty_or_system");
});

test("attachment markdown is stripped before speaking", () => {
  const event = message({
    content: "Here it is\n[shot.png](https://relay.example/media/abc)",
    tags: [
      ["h", CHANNEL],
      ["imeta", "url https://relay.example/media/abc", "m image/png"],
    ],
  });
  assert.equal(textWithoutAttachments(event).trim(), "Here it is");
  const result = classifySpeakableAgentText(event, agents, HUMAN, CHANNEL);
  assert.equal(result.text, "Here it is");
});

test("a message with no imeta tag keeps its content verbatim", () => {
  const event = message({ content: "[link](https://example.com/x)" });
  assert.equal(textWithoutAttachments(event), "[link](https://example.com/x)");
});

test("a message that is ONLY an attachment becomes unspeakable", () => {
  const event = message({
    content: "[shot.png](https://relay.example/media/abc)",
    tags: [
      ["h", CHANNEL],
      ["imeta", "url https://relay.example/media/abc"],
    ],
  });
  const result = classifySpeakableAgentText(event, agents, HUMAN, CHANNEL);
  assert.equal(result.reason, "empty_or_system");
});

test("bot members are read out of a 39002 snapshot by role, not position", () => {
  const bots = botPubkeysFromMemberEvent(
    {
      kind: 39002,
      tags: [
        ["d", CHANNEL],
        ["p", HUMAN, "", "member"],
        ["p", AGENT, "", "bot"],
        ["p", OTHER_AGENT, "", "admin"],
      ],
    },
    CHANNEL,
  );
  // Only the "bot" row: a member and an admin sit either side of it, so a
  // reader that took every p tag, or took the wrong index, fails here.
  assert.deepEqual([...bots], [AGENT]);
});

test("the role is index 3, past the empty relay url", () => {
  // A snapshot whose role sits at index 2 must NOT be accepted: that is the
  // shape a reader gets wrong, and the relay never emits it.
  const bots = botPubkeysFromMemberEvent(
    {
      kind: 39002,
      tags: [
        ["d", CHANNEL],
        ["p", AGENT, "bot"],
      ],
    },
    CHANNEL,
  );
  assert.equal(bots.size, 0);
});

test("another channel's member snapshot is rejected, not read as empty", () => {
  assert.equal(
    botPubkeysFromMemberEvent(
      {
        kind: 39002,
        tags: [
          ["d", "eph-2"],
          ["p", AGENT, "", "bot"],
        ],
      },
      CHANNEL,
    ),
    null,
  );
});

test("a non-39002 event is not a member snapshot", () => {
  assert.equal(
    botPubkeysFromMemberEvent(
      {
        kind: 39000,
        tags: [
          ["d", CHANNEL],
          ["p", AGENT, "", "bot"],
        ],
      },
      CHANNEL,
    ),
    null,
  );
});

test("bot pubkeys are normalised to lowercase", () => {
  const bots = botPubkeysFromMemberEvent(
    {
      kind: 39002,
      tags: [
        ["d", CHANNEL],
        ["p", AGENT.toUpperCase(), "", "bot"],
      ],
    },
    CHANNEL,
  );
  assert.ok(bots.has(AGENT));
});

test("an agent already in the audio room is not spoken locally", () => {
  // A desktop is broadcasting its pocket-tts voice as a peer; speaking here
  // too is the double-audio bug.
  assert.equal(shouldSpeakLocally(AGENT, [HUMAN, AGENT]), false);
});

test("an agent absent from the audio room IS spoken locally", () => {
  // Same call, different roster — the two cases must not agree.
  assert.equal(shouldSpeakLocally(AGENT, [HUMAN, OTHER_AGENT]), true);
});

test("audio-peer suppression is case-insensitive", () => {
  assert.equal(shouldSpeakLocally(AGENT, [AGENT.toUpperCase()]), false);
});

test("an empty audio roster suppresses nothing", () => {
  assert.equal(shouldSpeakLocally(AGENT, []), true);
});

test("the speech filter is channel-scoped by #h", () => {
  const filter = huddleAgentSpeechFilter(CHANNEL, 1_787_800_000);
  assert.deepEqual(filter["#h"], [CHANNEL]);
  assert.deepEqual(filter.kinds, [9, 40002]);
  assert.equal(filter.since, 1_787_800_000);
});

test("the member-snapshot filter keys on #d, the addressable coordinate", () => {
  const filter = huddleMemberSnapshotFilter(CHANNEL);
  assert.deepEqual(filter["#d"], [CHANNEL]);
  assert.deepEqual(filter.kinds, [39002]);
});

test("the ordered speaker starts disabled and refuses work", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    spoken.push(text);
  });
  assert.equal(speaker.enqueue("one", AGENT), "disabled");
  await Promise.resolve();
  assert.deepEqual(spoken, []);
});

test("enabled utterances are spoken in arrival order", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    // Resolve out of order on purpose: a naive implementation that fired
    // these concurrently would record "two" first.
    await new Promise((resolve) =>
      setTimeout(resolve, text === "one" ? 20 : 0),
    );
    spoken.push(text);
  });
  speaker.setEnabled(true);
  assert.equal(speaker.enqueue("one", AGENT), "queued");
  assert.equal(speaker.enqueue("two", AGENT), "queued");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(spoken.length, 2);
  assert.deepEqual(spoken, ["one", "two"]);
});

test("disabling mid-queue lets the in-flight utterance finish and drops the rest", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    spoken.push(text);
  });
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  // Let "one" actually enter speak() before the queue is torn down: the
  // generation check runs when an entry STARTS, so a still-pending entry is
  // dropped and only a started one survives.
  await new Promise((resolve) => setTimeout(resolve, 5));
  speaker.enqueue("two", AGENT);
  speaker.setEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(spoken.length, 1);
  assert.deepEqual(spoken, ["one"]);
});

test("disabling before anything starts drops the whole queue", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    spoken.push(text);
  });
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  speaker.enqueue("two", AGENT);
  speaker.setEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(spoken.length, 0);
});

test("cancel drops the queue without disabling future speech", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    spoken.push(text);
  });
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  speaker.enqueue("two", AGENT);
  speaker.cancel();
  // Still enabled: the next utterance is accepted AND spoken, which is what
  // separates cancel() from setEnabled(false).
  assert.equal(speaker.enqueue("three", AGENT), "queued");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(spoken, ["three"]);
});

test("a throwing speak call does not wedge the queue", async () => {
  const spoken = [];
  const errors = [];
  const speaker = createOrderedSpeaker(
    async (text) => {
      if (text === "one") throw new Error("voice unavailable");
      spoken.push(text);
    },
    (error) => errors.push(error),
  );
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  speaker.enqueue("two", AGENT);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(errors.length, 1);
  assert.deepEqual(spoken, ["two"]);
});

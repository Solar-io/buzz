import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHuddleReactionEvent,
  clampReactionName,
  HUDDLE_REACTION_KIND,
  HUDDLE_REACTION_NAME_MAX,
  huddleReactionFilter,
  huddleReactionFromEvent,
  reactionShortcode,
} from "./huddleReactions.ts";

const SELF = "a".repeat(64);
const fallback = (pubkey) => `Participant ${pubkey.slice(0, 6)}`;

function reactionEvent(overrides = {}) {
  return {
    kind: 24810,
    pubkey: SELF,
    content: "🎉",
    tags: [
      ["h", "eph-1"],
      ["reaction", "🎉"],
      ["sender_name", "Ada"],
    ],
    ...overrides,
  };
}

test("the reaction kind is 24810, matching buzz-core", () => {
  // Hardcoded, not derived: a test phrased as `KIND + 0` would follow the
  // constant anywhere it drifted to.
  assert.equal(HUDDLE_REACTION_KIND, 24810);
});

test("a well-formed reaction decodes to emoji + sender", () => {
  const reaction = huddleReactionFromEvent(reactionEvent(), fallback);
  assert.deepEqual(reaction, {
    emoji: "🎉",
    emojiUrl: null,
    senderName: "Ada",
  });
});

test("a non-24810 event is not a reaction", () => {
  // 24811 and 40002 both discriminate: neither is the reaction kind, and one
  // of them is an ordinary message that shares the channel.
  assert.equal(
    huddleReactionFromEvent(reactionEvent({ kind: 24811 }), fallback),
    null,
  );
  assert.equal(
    huddleReactionFromEvent(reactionEvent({ kind: 40002 }), fallback),
    null,
  );
});

test("the reaction tag wins over content when they differ", () => {
  const reaction = huddleReactionFromEvent(
    reactionEvent({
      content: "💀",
      tags: [
        ["h", "eph-1"],
        ["reaction", "🎉"],
      ],
    }),
    fallback,
  );
  assert.equal(reaction.emoji, "🎉");
});

test("content carries the emoji when no reaction tag is present", () => {
  const reaction = huddleReactionFromEvent(
    reactionEvent({ content: "💀", tags: [["h", "eph-1"]] }),
    fallback,
  );
  assert.equal(reaction.emoji, "💀");
});

test("an emoji-less reaction decodes to null rather than an empty burst", () => {
  assert.equal(
    huddleReactionFromEvent(
      reactionEvent({ content: "   ", tags: [["h", "eph-1"]] }),
      fallback,
    ),
    null,
  );
});

test("a custom-emoji reaction resolves its NIP-30 image url", () => {
  const reaction = huddleReactionFromEvent(
    reactionEvent({
      content: ":party:",
      tags: [
        ["h", "eph-1"],
        ["reaction", ":party:"],
        ["emoji", "party", "https://relay.example/media/abc"],
        ["sender_name", "Ada"],
      ],
    }),
    fallback,
  );
  assert.equal(reaction.emoji, ":party:");
  assert.equal(reaction.emojiUrl, "https://relay.example/media/abc");
});

test("an emoji tag for a DIFFERENT shortcode is not borrowed", () => {
  // Discriminating fixture: the tag is well-formed, just not this emoji's.
  const reaction = huddleReactionFromEvent(
    reactionEvent({
      content: ":party:",
      tags: [
        ["h", "eph-1"],
        ["reaction", ":party:"],
        ["emoji", "sadface", "https://relay.example/media/wrong"],
      ],
    }),
    fallback,
  );
  assert.equal(reaction.emojiUrl, null);
});

test("a unicode reaction never picks up an emoji tag", () => {
  const reaction = huddleReactionFromEvent(
    reactionEvent({
      tags: [
        ["h", "eph-1"],
        ["reaction", "🎉"],
        ["emoji", "party", "https://relay.example/media/abc"],
      ],
    }),
    fallback,
  );
  assert.equal(reaction.emojiUrl, null);
});

test("a missing sender_name falls back to the caller's namer", () => {
  const reaction = huddleReactionFromEvent(
    reactionEvent({
      tags: [
        ["h", "eph-1"],
        ["reaction", "🎉"],
      ],
    }),
    fallback,
  );
  assert.equal(reaction.senderName, `Participant ${SELF.slice(0, 6)}`);
});

test("an oversized sender name is ellipsized to the 48-char cap", () => {
  const long = "N".repeat(200);
  const clamped = clampReactionName(long);
  // Hardcoded 48 rather than HUDDLE_REACTION_NAME_MAX, so raising the cap
  // cannot raise this expectation with it.
  assert.equal(clamped.length, 48);
  assert.ok(clamped.endsWith("…"));
  assert.equal(HUDDLE_REACTION_NAME_MAX, 48);
});

test("a name at the cap is left exactly alone", () => {
  const exact = "N".repeat(48);
  assert.equal(clampReactionName(exact), exact);
});

test("shortcodes are recognised and lowercased; glyphs are not", () => {
  assert.equal(reactionShortcode(":Party:"), "party");
  assert.equal(reactionShortcode("🎉"), null);
  assert.equal(reactionShortcode("::"), null);
  assert.equal(reactionShortcode(":party"), null);
});

test("building a reaction produces the desktop's tag shape", () => {
  const built = buildHuddleReactionEvent({
    channelId: "eph-1",
    emoji: "🎉",
    senderName: "Ada",
  });
  assert.deepEqual(built.event, {
    kind: 24810,
    content: "🎉",
    tags: [
      ["h", "eph-1"],
      ["reaction", "🎉"],
      ["sender_name", "Ada"],
    ],
  });
});

test("a built reaction always carries an h tag", () => {
  // Without it `extract_channel_id` finds no channel and the relay routes the
  // event down the channel-less global path, where nobody in the huddle is
  // subscribed. This assertion is the whole reason the tag order is pinned.
  const built = buildHuddleReactionEvent({
    channelId: "eph-77",
    emoji: "👍",
    senderName: "Ada",
  });
  const hTags = built.event.tags.filter((tag) => tag[0] === "h");
  assert.equal(hTags.length, 1);
  assert.deepEqual(hTags[0], ["h", "eph-77"]);
});

test("a custom-emoji build carries the NIP-30 emoji tag", () => {
  const built = buildHuddleReactionEvent({
    channelId: "eph-1",
    emoji: ":party:",
    senderName: "Ada",
    emojiUrl: "https://relay.example/media/abc",
  });
  assert.deepEqual(built.event.tags[3], [
    "emoji",
    "party",
    "https://relay.example/media/abc",
  ]);
});

test("a unicode build never emits an emoji tag even when a url is passed", () => {
  const built = buildHuddleReactionEvent({
    channelId: "eph-1",
    emoji: "🎉",
    senderName: "Ada",
    emojiUrl: "https://relay.example/media/abc",
  });
  assert.equal(
    built.event.tags.some((tag) => tag[0] === "emoji"),
    false,
  );
});

test("an empty emoji is refused rather than published", () => {
  const built = buildHuddleReactionEvent({
    channelId: "eph-1",
    emoji: "  ",
    senderName: "Ada",
  });
  assert.equal(built.error, "an emoji is required");
  assert.equal(built.event, undefined);
});

test("a missing channel id is refused", () => {
  const built = buildHuddleReactionEvent({
    channelId: "",
    emoji: "🎉",
    senderName: "Ada",
  });
  assert.equal(built.error, "channel id is required");
});

test("an oversized sender name is clamped on the wire, not just on render", () => {
  const built = buildHuddleReactionEvent({
    channelId: "eph-1",
    emoji: "🎉",
    senderName: "N".repeat(200),
  });
  const sender = built.event.tags.find((tag) => tag[0] === "sender_name")[1];
  assert.equal(sender.length, 48);
});

test("the live filter is channel-scoped by #h", () => {
  // A filter without #h registers the WHOLE subscription as global
  // (extract_channel_ids_from_filters), after which no channel-carrying event
  // is ever delivered — the subscription looks alive and receives nothing.
  const filter = huddleReactionFilter("eph-1", 1_787_800_000);
  assert.deepEqual(filter["#h"], ["eph-1"]);
  assert.deepEqual(filter.kinds, [24810]);
  assert.equal(filter.since, 1_787_800_000);
});

test("the live filter asks for exactly one channel", () => {
  const filter = huddleReactionFilter("eph-2", 0);
  assert.equal(filter["#h"].length, 1);
});

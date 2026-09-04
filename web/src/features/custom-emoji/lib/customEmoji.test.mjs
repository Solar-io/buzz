import assert from "node:assert/strict";
import test from "node:test";

import {
  communityEmojiFilter,
  customEmojiFromTags,
  emojiUrlMap,
  KIND_EMOJI_SET,
  CUSTOM_EMOJI_SET_D_TAG,
  normalizeShortcode,
  reactionEmojiUrl,
  searchCustomEmoji,
  unionCustomEmoji,
} from "./customEmoji.ts";

// The wire constants are pinned to literals, not to each other: the point of
// the test is that a typo here would diverge from buzz-core/buzz-sdk, and an
// assertion phrased in terms of the constant could not catch that.
test("the emoji-set kind and d-tag match the relay's", () => {
  assert.equal(KIND_EMOJI_SET, 30030);
  assert.equal(CUSTOM_EMOJI_SET_D_TAG, "buzz:custom-emoji");
});

test("the community filter asks for every member's set under the d-tag", () => {
  assert.deepEqual(communityEmojiFilter(7), {
    kinds: [30030],
    "#d": ["buzz:custom-emoji"],
    limit: 7,
  });
});

test("normalizeShortcode follows normalize_custom_emoji_shortcode", () => {
  assert.equal(normalizeShortcode("  :Party_Parrot:  "), "party_parrot");
  assert.equal(normalizeShortcode("ship-it"), "ship-it");
  assert.equal(normalizeShortcode("A1"), "a1");
  // Rejections, each for the reason the Rust rejects it.
  assert.equal(normalizeShortcode("::"), null, "empty after stripping colons");
  assert.equal(normalizeShortcode("party parrot"), null, "space");
  assert.equal(normalizeShortcode("café"), null, "non-ASCII");
  assert.equal(normalizeShortcode("a!"), null, "punctuation");
  assert.equal(normalizeShortcode("a".repeat(64)), "a".repeat(64), "64 is ok");
  assert.equal(normalizeShortcode("a".repeat(65)), null, "65 is too long");
});

test("customEmojiFromTags reads NIP-30 emoji tags and skips the rest", () => {
  const emoji = customEmojiFromTags([
    ["d", "buzz:custom-emoji"],
    ["emoji", "ShipIt", "https://relay.example/s.png"],
    ["emoji", "no-url"],
    ["emoji", "bad name", "https://relay.example/b.png"],
    ["p", "deadbeef"],
    ["emoji", "shipit", "https://relay.example/duplicate.png"],
  ]);
  assert.deepEqual(emoji, [
    { shortcode: "shipit", url: "https://relay.example/s.png" },
  ]);
});

const setEvent = (pubkey, createdAt, entries) => ({
  pubkey,
  created_at: createdAt,
  tags: [
    ["d", "buzz:custom-emoji"],
    ...entries.map(([shortcode, url]) => ["emoji", shortcode, url]),
  ],
});

test("unionCustomEmoji merges every member's set, sorted by shortcode", () => {
  const palette = unionCustomEmoji([
    setEvent("alice", 100, [["zebra", "https://a/z.png"]]),
    setEvent("bob", 100, [["apple", "https://b/a.png"]]),
  ]);
  assert.deepEqual(palette, [
    { shortcode: "apple", url: "https://b/a.png" },
    { shortcode: "zebra", url: "https://a/z.png" },
  ]);
});

test("a shortcode claimed twice resolves to the newer set, whatever the order", () => {
  const older = setEvent("alice", 100, [
    ["shipit", "https://old.example/s.png"],
  ]);
  const newer = setEvent("bob", 200, [["shipit", "https://new.example/s.png"]]);
  const forwards = unionCustomEmoji([older, newer]);
  const backwards = unionCustomEmoji([newer, older]);
  assert.deepEqual(forwards, [
    { shortcode: "shipit", url: "https://new.example/s.png" },
  ]);
  assert.deepEqual(backwards, forwards, "fetch order must not matter");
});

test("an exact created_at tie breaks to the smaller URL, both ways round", () => {
  const a = setEvent("alice", 500, [["tie", "https://aaa.example/t.png"]]);
  const b = setEvent("bob", 500, [["tie", "https://bbb.example/t.png"]]);
  assert.deepEqual(unionCustomEmoji([a, b]), [
    { shortcode: "tie", url: "https://aaa.example/t.png" },
  ]);
  assert.deepEqual(unionCustomEmoji([b, a]), [
    { shortcode: "tie", url: "https://aaa.example/t.png" },
  ]);
});

test("emojiUrlMap indexes by shortcode", () => {
  const map = emojiUrlMap([{ shortcode: "shipit", url: "https://x/s.png" }]);
  assert.equal(map.get("shipit"), "https://x/s.png");
  assert.equal(map.get("nope"), undefined);
});

const PALETTE = [
  { shortcode: "party_parrot", url: "https://relay.example/p.gif" },
  { shortcode: "shipit", url: "https://relay.example/s.png" },
];

test("reactionEmojiUrl resolves a custom reaction and nothing else", () => {
  assert.equal(
    reactionEmojiUrl(":shipit:", PALETTE),
    "https://relay.example/s.png",
  );
  assert.equal(
    reactionEmojiUrl(":ShipIt:", PALETTE),
    "https://relay.example/s.png",
    "content from another client may not be lowercased",
  );
  assert.equal(reactionEmojiUrl("👍", PALETTE), undefined, "unicode reaction");
  assert.equal(reactionEmojiUrl(":unknown:", PALETTE), undefined);
  assert.equal(reactionEmojiUrl("shipit", PALETTE), undefined, "no colons");
  assert.equal(reactionEmojiUrl(":shipit:", undefined), undefined);
});

test("searchCustomEmoji ranks exact over prefix over substring", () => {
  const palette = [
    { shortcode: "megaship", url: "https://x/1.png" },
    { shortcode: "ship", url: "https://x/2.png" },
    { shortcode: "shipit", url: "https://x/3.png" },
  ];
  assert.deepEqual(
    searchCustomEmoji(palette, "ship").map((entry) => entry.shortcode),
    ["ship", "shipit", "megaship"],
  );
  assert.deepEqual(
    searchCustomEmoji(palette, ":ship:").map((e) => e.shortcode),
    ["ship", "shipit", "megaship"],
  );
  assert.deepEqual(searchCustomEmoji(palette, "   "), []);
  assert.deepEqual(searchCustomEmoji(palette, "zzz"), []);
});

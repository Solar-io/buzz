import assert from "node:assert/strict";
import test from "node:test";

import {
  allUnicodeEmoji,
  matchRank,
  parseEmojiTable,
  searchUnicodeEmoji,
  SKIN_TONE_COUNT,
  toneGlyph,
  unicodeEmojiCategories,
} from "./unicodeEmoji.ts";

const RECORD =
  "thumbsup|\u{1F44D}|yes good like|\u{1F44D}\u{1F3FB},\u{1F44D}\u{1F3FC},\u{1F44D}\u{1F3FD},\u{1F44D}\u{1F3FE},\u{1F44D}\u{1F3FF}";

test("parseEmojiTable decodes id, glyph, keywords and tones", () => {
  const [emoji, ...rest] = parseEmojiTable(RECORD);
  assert.equal(rest.length, 0);
  assert.equal(emoji.id, "thumbsup");
  assert.equal(emoji.glyph, "\u{1F44D}");
  assert.equal(emoji.keywords, "yes good like");
  assert.equal(emoji.tones.length, SKIN_TONE_COUNT);
  assert.equal(emoji.tones[0], "\u{1F44D}\u{1F3FB}");
  assert.equal(emoji.tones[4], "\u{1F44D}\u{1F3FF}");
});

test("an emoji with no tone field reports no tones", () => {
  const [emoji] = parseEmojiTable("grinning|\u{1F600}|smile happy|");
  assert.deepEqual(emoji.tones, []);
});

test("a tone field that is not five entries is discarded, not half-read", () => {
  const [emoji] = parseEmojiTable("broken|\u{1F600}|kw|a,b");
  assert.deepEqual(emoji.tones, []);
});

test("malformed records are skipped rather than throwing", () => {
  const parsed = parseEmojiTable(
    "|\u{1F600}|kw|;ok|\u{1F601}|kw|;noglyph||kw|",
  );
  assert.deepEqual(
    parsed.map((entry) => entry.id),
    ["ok"],
  );
  assert.deepEqual(parseEmojiTable(""), []);
});

test("toneGlyph picks the variant, and falls back when there is none", () => {
  const [toned] = parseEmojiTable(RECORD);
  const [plain] = parseEmojiTable("grinning|\u{1F600}|smile|");
  assert.equal(toneGlyph(toned, 0), "\u{1F44D}");
  assert.equal(toneGlyph(toned, 3), "\u{1F44D}\u{1F3FD}");
  assert.equal(toneGlyph(toned, 5), "\u{1F44D}\u{1F3FF}");
  assert.equal(toneGlyph(plain, 4), "\u{1F600}", "no tones, default glyph");
  assert.equal(toneGlyph(toned, -1), "\u{1F44D}");
});

test("matchRank orders exact id above prefix above keyword above substring", () => {
  const emoji = { id: "shipit", glyph: "x", keywords: "boat sail", tones: [] };
  assert.equal(matchRank(emoji, "shipit"), 0);
  assert.equal(matchRank(emoji, "ship"), 1);
  assert.equal(matchRank(emoji, "boat"), 2);
  assert.equal(matchRank(emoji, "hipi"), 3);
  assert.equal(matchRank(emoji, "sai"), 4);
  assert.equal(matchRank(emoji, "at sa"), 5);
  assert.equal(matchRank(emoji, "zzz"), -1);
  assert.equal(matchRank(emoji, "   "), -1, "an empty query matches nothing");
  assert.equal(matchRank(emoji, ":shipit:"), 0, "colons are stripped");
});

// The generated table is data this app ships; a truncated or mis-encoded
// regeneration must fail here rather than quietly halving the picker.
test("the shipped table decodes to a full emoji set", () => {
  const categories = unicodeEmojiCategories();
  assert.equal(categories.length, 8);
  assert.deepEqual(
    categories.map((category) => category.id),
    [
      "people",
      "nature",
      "foods",
      "activity",
      "places",
      "objects",
      "symbols",
      "flags",
    ],
  );
  const all = allUnicodeEmoji();
  assert.ok(all.length > 1800, `expected >1800 emoji, got ${all.length}`);
  assert.ok(
    all.every((emoji) => emoji.id !== "" && emoji.glyph !== ""),
    "every decoded record has an id and a glyph",
  );
  const toned = all.filter((emoji) => emoji.tones.length === SKIN_TONE_COUNT);
  assert.ok(
    toned.length > 250,
    `expected >250 tone-capable, got ${toned.length}`,
  );
});

test("searching the shipped table finds the obvious things", () => {
  const thumbs = searchUnicodeEmoji("thumbsup");
  assert.equal(thumbs[0].glyph, "\u{1F44D}");

  const heart = searchUnicodeEmoji("heart");
  assert.ok(heart.length > 5, "several hearts exist");
  assert.ok(heart.every((emoji) => matchRank(emoji, "heart") >= 0));

  assert.deepEqual(searchUnicodeEmoji("zzzzzznotanemoji"), []);
  assert.deepEqual(searchUnicodeEmoji(""), []);
  assert.equal(searchUnicodeEmoji("a", 12).length, 12, "the limit is honoured");
});

test("a keyword-only query still finds its emoji", () => {
  // "pizza" is the id, so use a term that only appears in the keyword blob.
  const results = searchUnicodeEmoji("bicycle");
  assert.ok(results.length > 0);
});

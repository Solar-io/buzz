import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomEmojiTags,
  buildReactionEmojiTag,
} from "./customEmojiTags.ts";

const PALETTE = [
  { shortcode: "party_parrot", url: "https://relay.example/p.gif" },
  { shortcode: "shipit", url: "https://relay.example/s.png" },
];

/**
 * NIP-30 defines the tag as `["emoji", <shortcode>, <image-url>]` and the
 * content as referencing it by `:shortcode:`. This asserts that literal shape —
 * three elements, that order, that first element, no colons on the shortcode —
 * rather than comparing the builder against itself.
 */
test("an emitted tag has exactly the NIP-30 shape", () => {
  const [tag, ...rest] = buildCustomEmojiTags("ship it :shipit:", PALETTE);
  assert.equal(rest.length, 0, "one referenced emoji, one tag");
  assert.ok(Array.isArray(tag));
  assert.equal(tag.length, 3, "NIP-30 emoji tags have three elements");
  assert.equal(tag[0], "emoji");
  assert.equal(tag[1], "shipit");
  assert.equal(tag[2], "https://relay.example/s.png");
  assert.ok(!tag[1].includes(":"), "the tag carries a bare shortcode");
  assert.match(tag[2], /^https?:\/\//, "the third element is the image URL");
});

test("only shortcodes actually present in the content are tagged", () => {
  assert.deepEqual(buildCustomEmojiTags("nothing to see", PALETTE), []);
  assert.deepEqual(buildCustomEmojiTags(":shipit:", PALETTE), [
    ["emoji", "shipit", "https://relay.example/s.png"],
  ]);
});

test("unknown shortcodes are not tagged", () => {
  assert.deepEqual(buildCustomEmojiTags("hello :thinking: world", PALETTE), []);
});

test("repeats collapse to one tag, in first-appearance order", () => {
  assert.deepEqual(
    buildCustomEmojiTags(":shipit: :party_parrot: :shipit:", PALETTE),
    [
      ["emoji", "shipit", "https://relay.example/s.png"],
      ["emoji", "party_parrot", "https://relay.example/p.gif"],
    ],
  );
});

test("a mixed-case shortcode is tagged in canonical lowercase", () => {
  assert.deepEqual(buildCustomEmojiTags("look: :ShipIt:", PALETTE), [
    ["emoji", "shipit", "https://relay.example/s.png"],
  ]);
});

test("an empty palette tags nothing", () => {
  assert.deepEqual(buildCustomEmojiTags(":shipit:", []), []);
});

test("buildReactionEmojiTag matches build_custom_emoji_reaction's tag", () => {
  const tag = buildReactionEmojiTag(":party_parrot:", PALETTE);
  assert.deepEqual(tag, [
    "emoji",
    "party_parrot",
    "https://relay.example/p.gif",
  ]);
});

test("a unicode or unknown reaction gets no emoji tag", () => {
  assert.equal(buildReactionEmojiTag("👍", PALETTE), null);
  assert.equal(buildReactionEmojiTag("+", PALETTE), null);
  assert.equal(buildReactionEmojiTag(":unknown:", PALETTE), null);
  assert.equal(buildReactionEmojiTag("shipit", PALETTE), null);
});

/**
 * `validate_reaction_emoji` (buzz-relay ingest.rs:160) admits a reaction over
 * 64 characters ONLY when it is a canonical lowercase `:shortcode:` carrying a
 * matching emoji tag. A 63-character shortcode is 65 characters wrapped, so
 * this is the case where the tag is admission, not decoration.
 */
test("a long shortcode still produces the tag its reaction needs", () => {
  const shortcode = "a".repeat(63);
  const palette = [{ shortcode, url: "https://relay.example/long.png" }];
  const reaction = `:${shortcode}:`;
  assert.equal(reaction.length, 65);
  assert.deepEqual(buildReactionEmojiTag(reaction, palette), [
    "emoji",
    shortcode,
    "https://relay.example/long.png",
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  addOwnEmoji,
  emojiEditMessage,
  ownEmojiSetTags,
  removeOwnEmoji,
  renameOwnEmoji,
  suggestShortcodeFromFilename,
} from "./ownEmojiSet.ts";

const PARROT = { shortcode: "parrot", url: "https://relay.test/media/a.gif" };
const SHIP = { shortcode: "ship", url: "https://relay.test/media/b.png" };
const OWN = [PARROT, SHIP];

test("the published tags carry the d-tag first, then one tag per emoji", () => {
  // Pinned to literals: these are the wire format the relay validates
  // (`validate_custom_emoji_tags`), so an expectation derived from the
  // constants would move with a typo instead of catching it.
  assert.deepEqual(ownEmojiSetTags(OWN), [
    ["d", "buzz:custom-emoji"],
    ["emoji", "parrot", "https://relay.test/media/a.gif"],
    ["emoji", "ship", "https://relay.test/media/b.png"],
  ]);
});

test("an empty set still publishes the d-tag — that is how a set is cleared", () => {
  // Without the d-tag the event is not parameterized-replaceable and would
  // never replace the old set, so removing the last emoji would do nothing.
  assert.deepEqual(ownEmojiSetTags([]), [["d", "buzz:custom-emoji"]]);
});

test("suggestShortcodeFromFilename mirrors the desktop's filename rules", () => {
  assert.equal(
    suggestShortcodeFromFilename("Party Parrot.GIF"),
    "party_parrot",
  );
  assert.equal(suggestShortcodeFromFilename("/tmp/dir/ship-it.png"), "ship-it");
  assert.equal(
    suggestShortcodeFromFilename("__weird!!name__.webp"),
    "weird_name",
  );
  assert.equal(suggestShortcodeFromFilename("C:\\Users\\me\\Yes.png"), "yes");
  // Nothing legal survives — the caller must type a name.
  assert.equal(suggestShortcodeFromFilename("!!!.png"), null);
  assert.equal(suggestShortcodeFromFilename(".gitignore"), null);
});

test("add normalizes the shortcode and sorts the result", () => {
  const result = addOwnEmoji(
    OWN,
    ":Aardvark:",
    "https://relay.test/media/c.png",
  );
  assert.ok(result.ok);
  assert.equal(result.shortcode, "aardvark");
  assert.deepEqual(
    result.next.map((entry) => entry.shortcode),
    ["aardvark", "parrot", "ship"],
  );
});

test("add replaces the image of a shortcode I already own, without duplicating it", () => {
  const result = addOwnEmoji(OWN, "parrot", "https://relay.test/media/new.gif");
  assert.ok(result.ok);
  assert.equal(result.next.length, 2);
  assert.deepEqual(
    result.next.filter((entry) => entry.shortcode === "parrot"),
    [{ shortcode: "parrot", url: "https://relay.test/media/new.gif" }],
  );
});

test("add refuses an illegal shortcode, an empty url, and a no-op", () => {
  assert.deepEqual(addOwnEmoji(OWN, "no spaces", "u"), {
    ok: false,
    error: "invalid-shortcode",
  });
  assert.deepEqual(addOwnEmoji(OWN, "ok", "   "), {
    ok: false,
    error: "missing-url",
  });
  assert.deepEqual(addOwnEmoji(OWN, "parrot", PARROT.url), {
    ok: false,
    error: "unchanged",
  });
});

test("rename moves the image to the new shortcode and drops the old one", () => {
  const result = renameOwnEmoji(OWN, "parrot", ":Macaw:");
  assert.ok(result.ok);
  assert.equal(result.shortcode, "macaw");
  assert.deepEqual(result.next, [
    { shortcode: "macaw", url: PARROT.url },
    SHIP,
  ]);
  // The old name must be gone, not merely reordered.
  assert.ok(!result.next.some((entry) => entry.shortcode === "parrot"));
});

test("rename refuses to overwrite another of my own emoji", () => {
  assert.deepEqual(renameOwnEmoji(OWN, "parrot", "ship"), {
    ok: false,
    error: "shortcode-taken",
  });
  // …and the set is untouched, so a refused rename cannot lose an emoji.
  assert.deepEqual(OWN, [PARROT, SHIP]);
});

test("rename refuses unknown sources, illegal targets, and a same-name rename", () => {
  assert.deepEqual(renameOwnEmoji(OWN, "nope", "fine"), {
    ok: false,
    error: "not-found",
  });
  assert.deepEqual(renameOwnEmoji(OWN, "parrot", "bad name"), {
    ok: false,
    error: "invalid-shortcode",
  });
  // ":Parrot:" normalizes to the same shortcode — a rename that changes
  // nothing must not cost a republish.
  assert.deepEqual(renameOwnEmoji(OWN, "parrot", ":Parrot:"), {
    ok: false,
    error: "unchanged",
  });
});

test("rename onto a name only SOMEONE ELSE uses is allowed", () => {
  // The palette resolves cross-member collisions deterministically
  // (unionCustomEmoji); refusing here would let any member reserve names.
  const result = renameOwnEmoji([PARROT], "parrot", "ship");
  assert.ok(result.ok);
  assert.deepEqual(result.next, [{ shortcode: "ship", url: PARROT.url }]);
});

test("remove drops exactly one entry and leaves the rest", () => {
  const result = removeOwnEmoji(OWN, ":PARROT:");
  assert.ok(result.ok);
  assert.equal(result.shortcode, "parrot");
  assert.deepEqual(result.next, [SHIP]);
});

test("remove reports not-found for a shortcode I do not own", () => {
  assert.deepEqual(removeOwnEmoji(OWN, "ship-it"), {
    ok: false,
    error: "not-found",
  });
  assert.deepEqual(removeOwnEmoji(OWN, "!!!"), {
    ok: false,
    error: "not-found",
  });
});

test("removing my last emoji yields an empty set, not a refusal", () => {
  const result = removeOwnEmoji([PARROT], "parrot");
  assert.ok(result.ok);
  assert.deepEqual(result.next, []);
});

test("every refusal reason has a message a person can act on", () => {
  const errors = [
    "invalid-shortcode",
    "missing-url",
    "not-found",
    "shortcode-taken",
    "unchanged",
  ];
  const messages = errors.map(emojiEditMessage);
  assert.equal(new Set(messages).size, errors.length);
  for (const message of messages) {
    assert.ok(message.length > 0);
    assert.ok(!message.includes("-"), `"${message}" reads like an error code`);
  }
});

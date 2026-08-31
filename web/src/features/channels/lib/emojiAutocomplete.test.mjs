import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeEmojiQuery,
  applyEmojiCompletion,
  emojiForCode,
  emojiSuggestions,
} from "./emojiAutocomplete.ts";

test("activeEmojiQuery finds the open token at the caret", () => {
  assert.equal(activeEmojiQuery("hi :smil", 8), "smil");
  // Caret before the token start, closed tokens, spaces, and bare colons
  // all yield null.
  assert.equal(activeEmojiQuery("hi :smile: there", 16), null);
  assert.equal(activeEmojiQuery("no colon here", 5), null);
  // A second colon starts a fresh token — ":words" here is legitimately open.
  assert.equal(activeEmojiQuery(":two:words", 10), "words");
  assert.equal(activeEmojiQuery(":", 1), null);
});

test("emojiSuggestions prefix-match and cap", () => {
  const hearts = emojiSuggestions("heart");
  assert.ok(hearts.length <= 6);
  assert.ok(
    hearts.some((s) => s.emoji === "❤️"),
    "heart itself matches",
  );
  assert.ok(
    hearts.every((s) => s.code.includes(":heart")),
    "all suggestions contain the token",
  );
  assert.deepEqual(emojiSuggestions("zzzz"), []);
});

test("applyEmojiCompletion replaces the open token", () => {
  const out = applyEmojiCompletion("hi :smil rest", 8, "😄");
  assert.equal(out.text, "hi 😄 rest");
  assert.equal(out.caret, 5);
  // No open token: unchanged.
  const same = applyEmojiCompletion("plain", 5, "🔥");
  assert.equal(same.text, "plain");
});

test("emojiForCode resolves full codes", () => {
  assert.equal(emojiForCode(":rocket:"), "🚀");
  assert.equal(emojiForCode(":nope:"), undefined);
});

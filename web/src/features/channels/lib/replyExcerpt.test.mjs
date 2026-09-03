import assert from "node:assert/strict";
import { test } from "node:test";
import { replyExcerpt } from "./replyExcerpt.ts";

const FENCE = "`".repeat(3);

test("plain prose passes through unchanged", () => {
  assert.equal(replyExcerpt("ship it on Friday"), "ship it on Friday");
});

test("newlines collapse to one line", () => {
  assert.equal(replyExcerpt("first\n\nsecond\tthird"), "first second third");
});

test("emphasis and spoiler markers are dropped, the words kept", () => {
  assert.equal(
    replyExcerpt("**bold** and _soft_ and ~~gone~~"),
    "bold and soft and gone",
  );
  assert.equal(replyExcerpt("the ||twist||"), "the twist");
});

test("a link keeps its label and loses the target", () => {
  assert.equal(
    replyExcerpt("see [the docs](https://example.test/a/b) now"),
    "see the docs now",
  );
});

test("an attachment embed becomes a short placeholder", () => {
  assert.equal(
    replyExcerpt("look\n![image](https://r/1.png)"),
    "look 📎 attachment",
  );
});

test("a code fence loses its markers but keeps the code", () => {
  assert.equal(replyExcerpt(`${FENCE}ts\nlet x = 1\n${FENCE}`), "let x = 1");
});

test("a long message is truncated with an ellipsis", () => {
  const long = "word ".repeat(60).trim();
  const out = replyExcerpt(long, 40);
  assert.ok(out.length <= 41, `got ${out.length} chars: ${out}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.endsWith(" …"), "the cut trims trailing space first");
});

test("truncation prefers a word boundary near the limit", () => {
  const out = replyExcerpt("alpha bravo charlie delta echo", 22);
  assert.equal(out, "alpha bravo charlie…");
});

test("a message exactly at the limit is not truncated", () => {
  const exact = "0123456789";
  assert.equal(replyExcerpt(exact, 10), exact);
});

test("an empty or whitespace-only body excerpts to nothing", () => {
  assert.equal(replyExcerpt(""), "");
  assert.equal(replyExcerpt("   \n  "), "");
});

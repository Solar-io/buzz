import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCode,
  applyCodeBlock,
  applyLinePrefix,
  applyLink,
  applyOrderedList,
  applySpoiler,
  applyWrap,
  fencedBlockAt,
  fencedBlocks,
  wrapRange,
} from "./composerFormat.ts";

test("applyWrap wraps a selection and restores it inside the markers", () => {
  const out = applyWrap("say bold things", 4, 8, "**");
  assert.equal(out.text, "say **bold** things");
  assert.equal(out.selStart, 6);
  assert.equal(out.selEnd, 10);
});

test("applyWrap toggles off an already-wrapped selection", () => {
  const out = applyWrap("say **bold** things", 4, 12, "**");
  assert.equal(out.text, "say bold things");
  assert.equal(out.selEnd, 8);
});

test("applyWrap word-wraps a collapsed caret inside a word", () => {
  const out = applyWrap("say bold things", 6, 6, "**");
  assert.equal(out.text, "say **bold** things");
  assert.equal(out.selStart, 6);
  assert.equal(out.selEnd, 10);
});

test("applyWrap on an empty selection with no word inserts markers", () => {
  const out = applyWrap("", 0, 0, "_");
  assert.equal(out.text, "__");
  assert.equal(out.selStart, 1);
  assert.equal(out.selEnd, 1);
});

test("applyLink builds markdown link and selects the url placeholder", () => {
  const out = applyLink("see docs now", 4, 8);
  assert.equal(out.text, "see [docs](url) now");
  assert.equal(out.text.slice(out.selStart, out.selEnd), "url");
  const empty = applyLink("see", 3, 3);
  assert.equal(empty.text, "see[text](url)");
});

test("applyLinePrefix prefixes each selected line and toggles off", () => {
  const out = applyLinePrefix("a\nb\nc", 0, 5, "> ");
  assert.equal(out.text, "> a\n> b\n> c");
  const undone = applyLinePrefix("> a\n> b", 0, 6, "> ");
  assert.equal(undone.text, "a\nb");
  // Caret on one line prefixes just that line.
  const one = applyLinePrefix("x\ny", 3, 3, "- ");
  assert.equal(one.text, "x\n- y");
});

test("applyCode wraps with backticks", () => {
  const out = applyCode("run npm test here", 4, 7);
  assert.equal(out.text, "run `npm` test here");
});

// ── Code block ──────────────────────────────────────────────────────────────

const FENCE = "`".repeat(3);

test("applyCodeBlock fences the selected lines and selects the body", () => {
  const out = applyCodeBlock("const x = 1", 0, 11);
  assert.equal(out.text, `${FENCE}\nconst x = 1\n${FENCE}`);
  assert.equal(out.text.slice(out.selStart, out.selEnd), "const x = 1");
});

test("applyCodeBlock fences whole lines, not the character selection", () => {
  // The selection covers only "b c" but the fence must take the whole line.
  const out = applyCodeBlock("a\nb c d\ne", 2, 5);
  assert.equal(out.text, `a\n${FENCE}\nb c d\n${FENCE}\ne`);
});

test("applyCodeBlock toggles off from the MIDDLE of a long block", () => {
  const text = `${FENCE}\none\ntwo\nthree\n${FENCE}`;
  // Caret parked inside "two", nowhere near either fence.
  const caret = text.indexOf("two") + 1;
  const out = applyCodeBlock(text, caret, caret);
  assert.equal(out.text, "one\ntwo\nthree");
  assert.equal(out.text.slice(out.selStart, out.selEnd), "one\ntwo\nthree");
});

test("applyCodeBlock toggle-off keeps the surrounding prose", () => {
  const text = `before\n${FENCE}\nx\n${FENCE}\nafter`;
  const caret = text.indexOf("\nx") + 1;
  assert.equal(applyCodeBlock(text, caret, caret).text, "before\nx\nafter");
});

test("applyCodeBlock on an empty composer leaves the caret between fences", () => {
  const out = applyCodeBlock("", 0, 0);
  assert.equal(out.text, `${FENCE}\n\n${FENCE}`);
  assert.equal(out.selStart, 4);
  assert.equal(out.selEnd, 4);
});

test("fencedBlocks reports an info-string fence and an unterminated one", () => {
  const closed = fencedBlocks(`${FENCE}ts\nx\n${FENCE}`);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].unterminated, false);
  const halfTyped = `${FENCE}\nhalf typed`;
  const open = fencedBlocks(halfTyped);
  assert.equal(open.length, 1);
  assert.equal(open[0].unterminated, true);
  assert.equal(open[0].closeEnd, halfTyped.length);
});

test("fencedBlockAt refuses a selection straddling a fence boundary", () => {
  const text = `out\n${FENCE}\nin\n${FENCE}`;
  const inside = text.indexOf("\nin") + 1;
  // From the prose line into the code body — no single block contains it.
  assert.equal(fencedBlockAt(text, 0, inside + 1), null);
  assert.notEqual(fencedBlockAt(text, inside, inside + 2), null);
});

// ── Ordered list ────────────────────────────────────────────────────────────

test("applyOrderedList numbers each selected line from 1", () => {
  const out = applyOrderedList("a\nb\nc", 0, 5);
  assert.equal(out.text, "1. a\n2. b\n3. c");
});

test("applyOrderedList toggles a fully numbered block back off", () => {
  const out = applyOrderedList("1. a\n2. b", 0, 9);
  assert.equal(out.text, "a\nb");
});

test("applyOrderedList only renumbers when EVERY line is numbered", () => {
  const out = applyOrderedList("1. a\nb", 0, 6);
  assert.equal(out.text, "1. 1. a\n2. b");
});

test("applyOrderedList with a caret numbers just that line", () => {
  const out = applyOrderedList("x\ny", 3, 3);
  assert.equal(out.text, "x\n1. y");
});

// ── Spoiler ─────────────────────────────────────────────────────────────────

test("applySpoiler wraps the selection in Discord-style pipes", () => {
  const out = applySpoiler("the butler did it", 4, 10);
  assert.equal(out.text, "the ||butler|| did it");
  assert.equal(out.text.slice(out.selStart, out.selEnd), "butler");
});

test("applySpoiler toggles an already-spoilered selection off", () => {
  const out = applySpoiler("the ||butler|| did it", 4, 14);
  assert.equal(out.text, "the butler did it");
});

// ── Shared wrap range ───────────────────────────────────────────────────────

test("wrapRange extends a collapsed caret to its word and leaves ranges alone", () => {
  assert.deepEqual(wrapRange("say bold things", 6, 6), { start: 4, end: 8 });
  assert.deepEqual(wrapRange("say bold things", 0, 3), { start: 0, end: 3 });
  assert.deepEqual(wrapRange("", 0, 0), { start: 0, end: 0 });
});

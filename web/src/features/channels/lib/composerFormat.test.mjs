import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCode,
  applyLinePrefix,
  applyLink,
  applyWrap,
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

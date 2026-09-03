import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeMarks,
  isLinePrefixActive,
  isLinkActive,
  isOrderedListActive,
  isWrapActive,
} from "./composerActiveMarks.ts";
import {
  applyCode,
  applyCodeBlock,
  applyLinePrefix,
  applyOrderedList,
  applySpoiler,
  applyWrap,
} from "./composerFormat.ts";

const FENCE = "`".repeat(3);

test("bold reads active for a selection inside the markers", () => {
  const text = "say **bold** things";
  assert.equal(isWrapActive(text, 6, 10, "**"), true);
});

test("bold reads active for a caret parked inside the bold word", () => {
  const text = "say **bold** things";
  const caret = text.indexOf("bold") + 1;
  assert.equal(isWrapActive(text, caret, caret, "**"), true);
});

test("bold reads INACTIVE for plain text", () => {
  assert.equal(isWrapActive("say bold things", 4, 8, "**"), false);
});

test("italic markers do not make bold read active, or the reverse", () => {
  const bold = "say **bold** things";
  assert.equal(isWrapActive(bold, 6, 10, "_"), false, "** is not _");
  const italic = "say _soft_ things";
  assert.equal(isWrapActive(italic, 5, 9, "**"), false, "_ is not **");
  assert.equal(isWrapActive(italic, 5, 9, "_"), true);
});

test("strike and spoiler are told apart from one another", () => {
  const strike = "a ~~gone~~ b";
  assert.equal(isWrapActive(strike, 4, 8, "~~"), true);
  assert.equal(isWrapActive(strike, 4, 8, "||"), false);
  const spoiler = "a ||hidden|| b";
  assert.equal(isWrapActive(spoiler, 4, 10, "||"), true);
  assert.equal(isWrapActive(spoiler, 4, 10, "~~"), false);
});

test("a PARTIALLY bold selection reads inactive — a click would add, not remove", () => {
  // "**one** two" with the selection spanning the bold run and the next word.
  const text = "**one** two";
  assert.equal(isWrapActive(text, 2, 11, "**"), false);
});

test("list and quote read active only when EVERY touched line carries the marker", () => {
  assert.equal(isLinePrefixActive("- a\n- b", 0, 7, "- "), true);
  assert.equal(isLinePrefixActive("- a\nb", 0, 5, "- "), false);
  assert.equal(isLinePrefixActive("> q", 1, 1, "> "), true);
  assert.equal(isLinePrefixActive("q", 0, 1, "> "), false);
});

test("ordered list reads active for any numbering, not just 1.", () => {
  assert.equal(isOrderedListActive("1. a\n2. b", 0, 9), true);
  assert.equal(isOrderedListActive("12. a", 2, 2), true);
  assert.equal(isOrderedListActive("- a", 1, 1), false);
  assert.equal(isOrderedListActive("1. a\nb", 0, 6), false);
});

test("link reads active only for a caret inside the link span", () => {
  const text = "see [docs](https://x.test) now";
  const inside = text.indexOf("docs") + 1;
  assert.equal(isLinkActive(text, inside, inside), true);
  assert.equal(isLinkActive(text, 0, 3), false, "before the link");
  assert.equal(isLinkActive(text, text.length - 2, text.length), false);
});

test("inline code is forced inactive inside a fenced block", () => {
  // Both fixtures put backticks IMMEDIATELY around the selection, so the
  // inline-code wrap test would report active on its own. Only the fence gate
  // makes the answer false — remove it and both assertions below flip.
  const oneLine = `${FENCE}x${FENCE}`;
  const oneLineMarks = activeMarks(oneLine, 3, 4);
  assert.equal(oneLineMarks.codeBlock, true, "a lone fence opens a block");
  assert.equal(
    oneLineMarks.code,
    false,
    "the surrounding backticks are the fence, not an inline span",
  );

  // Literal backticks INSIDE a fenced block are not an inline span either —
  // markdown does not re-parse the contents of a code fence.
  const nested = `${FENCE}\n\`x\`\n${FENCE}`;
  const caret = nested.indexOf("x");
  const nestedMarks = activeMarks(nested, caret, caret + 1);
  assert.equal(nestedMarks.codeBlock, true);
  assert.equal(nestedMarks.code, false);
});

test("inline code still reads active outside a fence", () => {
  const text = "run `npm` here";
  assert.equal(activeMarks(text, 5, 8).code, true);
  assert.equal(activeMarks(text, 5, 8).codeBlock, false);
});

test("activeMarks over plain prose reports nothing active", () => {
  const marks = activeMarks("just some words", 5, 9);
  for (const [name, value] of Object.entries(marks)) {
    assert.equal(value, false, `${name} should be inactive`);
  }
});

// The property that makes aria-pressed truthful: pressed means the click
// REMOVES the mark. Each pair below applies the transform and asserts the
// result no longer carries it, and vice versa.
test("every mark that reads active is one the toggle removes", () => {
  const cases = [
    {
      name: "bold",
      text: "say **bold** things",
      start: 6,
      end: 10,
      apply: (t, s, e) => applyWrap(t, s, e, "**"),
      plain: "say bold things",
    },
    {
      name: "italic",
      text: "say _soft_ things",
      start: 5,
      end: 9,
      apply: (t, s, e) => applyWrap(t, s, e, "_"),
      plain: "say soft things",
    },
    {
      name: "strike",
      text: "a ~~gone~~ b",
      start: 4,
      end: 8,
      apply: (t, s, e) => applyWrap(t, s, e, "~~"),
      plain: "a gone b",
    },
    {
      name: "code",
      text: "run `npm` here",
      start: 5,
      end: 8,
      apply: applyCode,
      plain: "run npm here",
    },
    {
      name: "spoiler",
      text: "a ||hidden|| b",
      start: 4,
      end: 10,
      apply: applySpoiler,
      plain: "a hidden b",
    },
    {
      name: "bulletList",
      text: "- a\n- b",
      start: 0,
      end: 7,
      apply: (t, s, e) => applyLinePrefix(t, s, e, "- "),
      plain: "a\nb",
    },
    {
      name: "quote",
      text: "> a\n> b",
      start: 0,
      end: 7,
      apply: (t, s, e) => applyLinePrefix(t, s, e, "> "),
      plain: "a\nb",
    },
    {
      name: "orderedList",
      text: "1. a\n2. b",
      start: 0,
      end: 9,
      apply: applyOrderedList,
      plain: "a\nb",
    },
    {
      name: "codeBlock",
      text: `${FENCE}\nx\n${FENCE}`,
      start: 5,
      end: 5,
      apply: applyCodeBlock,
      plain: "x",
    },
  ];
  assert.equal(cases.length, 9, "one case per toggling mark");
  for (const item of cases) {
    const before = activeMarks(item.text, item.start, item.end);
    assert.equal(before[item.name], true, `${item.name} should start active`);
    const out = item.apply(item.text, item.start, item.end);
    assert.equal(out.text, item.plain, `${item.name} toggles the marker off`);
    const after = activeMarks(out.text, out.selStart, out.selEnd);
    assert.equal(after[item.name], false, `${item.name} is off afterwards`);
  }
});

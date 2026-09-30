import assert from "node:assert/strict";
import test from "node:test";

import remarkCallouts, { CALLOUT_TYPES } from "./remarkCallouts.ts";

function quote(...paragraphs) {
  return {
    type: "blockquote",
    children: paragraphs.map((children) => ({
      type: "paragraph",
      children: Array.isArray(children)
        ? children
        : [{ type: "text", value: children }],
    })),
  };
}

function run(...blocks) {
  const tree = { type: "root", children: blocks };
  remarkCallouts()(tree);
  return tree.children;
}

test("the five markers become callouts; an unknown marker stays a quote", () => {
  assert.deepEqual([...CALLOUT_TYPES], [
    "note",
    "tip",
    "important",
    "warning",
    "caution",
  ]);
  for (const type of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
    const [node] = run(quote(`[!${type}]\nbody text`));
    assert.equal(node.type, "callout", type);
    assert.deepEqual(node.data, {
      hName: "callout",
      hProperties: { "data-callout": type.toLowerCase() },
    });
    assert.deepEqual(node.children, [
      { type: "paragraph", children: [{ type: "text", value: "body text" }] },
    ]);
  }
  // Case-insensitive, like GitHub.
  assert.equal(run(quote("[!note]\nx"))[0].type, "callout");

  // Unknown marker, a plain quote, and a marker that is not first: untouched.
  for (const text of ["[!FOO]\nbody", "just a quote", "see [!NOTE] here"]) {
    const [node] = run(quote(text));
    assert.equal(node.type, "blockquote", text);
    assert.equal(node.children[0].children[0].value, text);
  }
});

test("text after the marker is the title when a body follows", () => {
  const [node] = run(quote("[!WARNING] Not tested\nAudio and win/lose."));
  assert.deepEqual(node.data.hProperties, {
    "data-callout": "warning",
    "data-title": "Not tested",
  });
  assert.deepEqual(node.children, [
    {
      type: "paragraph",
      children: [{ type: "text", value: "Audio and win/lose." }],
    },
  ]);

  // The marker line alone, with the body in a later block (a list, say).
  const list = { type: "list", children: [] };
  const block = quote("[!NOTE] Tested in Agent Brave");
  block.children.push(list);
  const [withList] = run(block);
  assert.equal(withList.data.hProperties["data-title"], "Tested in Agent Brave");
  assert.deepEqual(withList.children, [list]);
});

test("a one-line callout keeps its text as the body under the default title", () => {
  const [node] = run(quote("[!NOTE] All 212 tests pass."));
  assert.deepEqual(node.data.hProperties, { "data-callout": "note" });
  assert.deepEqual(node.children, [
    {
      type: "paragraph",
      children: [{ type: "text", value: "All 212 tests pass." }],
    },
  ]);
});

test("inline formatting after the marker survives as body", () => {
  const strong = { type: "strong", children: [{ type: "text", value: "green" }] };
  const [node] = run(
    quote([{ type: "text", value: "[!TIP] Suites are " }, strong]),
  );
  assert.equal(node.type, "callout");
  assert.deepEqual(node.children[0].children, [
    { type: "text", value: "Suites are " },
    strong,
  ]);
});

test("callouts nested in other blocks are found; quotes inside them are kept", () => {
  const item = { type: "listItem", children: [quote("[!CAUTION]\ndanger")] };
  const [list] = run({ type: "list", children: [item] });
  assert.equal(list.children[0].children[0].type, "callout");
  assert.equal(
    list.children[0].children[0].data.hProperties["data-callout"],
    "caution",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import remarkCustomEmoji from "./remarkCustomEmoji.ts";

const PALETTE = [{ shortcode: "shipit", url: "https://relay.example/s.png" }];

const text = (value) => ({ type: "text", value });
const paragraph = (...children) => ({ type: "paragraph", children });
const root = (...children) => ({ type: "root", children });

function transform(tree, palette = PALETTE) {
  remarkCustomEmoji({ palette })(tree);
  return tree;
}

test("a known shortcode becomes an emoji node with NIP-30 fallback alt text", () => {
  const tree = transform(root(paragraph(text("ship :shipit: now"))));
  const [before, emoji, after] = tree.children[0].children;
  assert.deepEqual(before, text("ship "));
  assert.deepEqual(after, text(" now"));
  assert.equal(emoji.type, "emoji");
  assert.equal(emoji.data.hName, "emoji");
  assert.equal(emoji.data.hProperties.src, "https://relay.example/s.png");
  assert.equal(emoji.data.hProperties.alt, ":shipit:");
  assert.equal(emoji.data.hProperties["data-shortcode"], "shipit");
});

test("an unknown shortcode is left exactly as typed", () => {
  const tree = transform(root(paragraph(text("hello :nope: there"))));
  assert.deepEqual(tree.children[0].children, [text("hello :nope: there")]);
});

test("an empty palette leaves the whole tree alone", () => {
  const tree = transform(root(paragraph(text(":shipit:"))), []);
  assert.deepEqual(tree.children[0].children, [text(":shipit:")]);
});

test("code and links are never rewritten", () => {
  const tree = transform(
    root(
      { type: "inlineCode", value: ":shipit:" },
      { type: "code", value: ":shipit:" },
      { type: "link", url: "#", children: [text(":shipit:")] },
    ),
  );
  assert.deepEqual(tree.children[2].children, [text(":shipit:")]);
  assert.equal(tree.children[0].value, ":shipit:");
  assert.equal(tree.children[1].value, ":shipit:");
});

test("emphasis and other nested inline nodes are walked into", () => {
  const tree = transform(
    root(paragraph({ type: "emphasis", children: [text("go :shipit:")] })),
  );
  const emphasis = tree.children[0].children[0];
  assert.equal(emphasis.children.length, 2);
  assert.equal(emphasis.children[1].type, "emoji");
});

/**
 * The walk goes backwards over children precisely so a splice does not shift
 * indices it has yet to visit. Forwards, the second shortcode in a paragraph
 * with two text children is the one that gets skipped.
 */
test("several shortcodes across several children all resolve", () => {
  const tree = transform(
    root(paragraph(text("a :shipit: b"), text("c :shipit: d"))),
  );
  const kinds = tree.children[0].children.map((node) => node.type);
  assert.deepEqual(kinds, ["text", "emoji", "text", "text", "emoji", "text"]);
});

test("a node with no children is not a crash", () => {
  assert.doesNotThrow(() => transform({ type: "root" }));
  assert.doesNotThrow(() => transform(root(text(":shipit:"))));
});

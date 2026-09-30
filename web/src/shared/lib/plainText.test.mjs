import assert from "node:assert/strict";
import test from "node:test";

import { plainExcerpt, plainText } from "./plainText.ts";

const TABLE = [
  "Unblinded, and it's an upset:",
  "",
  "| Game | Model | Score |",
  "|------|:-----:|------:|",
  "| C | Sol max | 5 |",
  "| D | Opus xhigh | 4 |",
].join("\n");

test("a table becomes cells, without the separator row", () => {
  assert.equal(
    plainText(TABLE),
    "Unblinded, and it's an upset: Game · Model · Score C · Sol max · 5 D · Opus xhigh · 4",
  );
});

test("a separator row without edge pipes is dropped too", () => {
  assert.equal(plainText("a | b\n--- | ---\n1 | 2"), "a | b 1 | 2");
});

test("callout markers, quotes, headings and bullets lose their syntax", () => {
  assert.equal(
    plainText(
      "## Result\n> [!WARNING] Not tested\n> Audio and win/lose.\n- one\n2. two",
    ),
    "Result Not tested Audio and win/lose. one two",
  );
});

test("fences and rules disappear; the code inside stays", () => {
  assert.equal(
    plainText("before\n```ts\nconst a = 1;\n```\n---\nafter"),
    "before const a = 1; after",
  );
});

test("links keep their label, embeds become the placeholder, emphasis goes", () => {
  assert.equal(
    plainText("**bold** _em_ `code` [label](http://x) ![pic](http://y.png)"),
    "bold em code label 📎 attachment",
  );
  assert.equal(
    plainText("![pic](http://y.png)", { embed: "📷 image" }),
    "📷 image",
  );
});

test("plainExcerpt cuts with an ellipsis and never exceeds the cap", () => {
  assert.equal(plainExcerpt("one two three four", 9), "one two…");
  assert.equal(plainExcerpt("short", 9), "short");
  assert.equal(plainExcerpt(TABLE, 40).length <= 40, true);
});

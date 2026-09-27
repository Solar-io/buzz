import assert from "node:assert/strict";
import { test } from "node:test";

import { speakableText, stripSpeakableMarkdown } from "./speakableText.ts";

test("emphasis, code, headings and links are stripped", () => {
  assert.equal(
    stripSpeakableMarkdown(
      "## Kyoto\n**Big** _gate_ at `Fushimi` — [map](https://m.test)",
    ),
    "Kyoto\nBig gate at Fushimi — map",
  );
});

test("snake_case survives; stray image markdown is dropped", () => {
  assert.equal(
    stripSpeakableMarkdown("see my_var here ![x](https://i.test/a.png)"),
    "see my_var here",
  );
});

test("the imeta image line is removed before speaking", () => {
  const url = "https://relay.test/media/abc.png";
  assert.equal(
    speakableText({
      id: "1",
      kind: 9,
      pubkey: "p",
      content: `We started at the gate.\n![image](${url})`,
      tags: [["imeta", `url ${url}`]],
    }),
    "We started at the gate.",
  );
});

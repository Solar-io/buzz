import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanWorkText, isShortTrigger, replyParentId } from "./workText.ts";

for (const [content, expected] of [
  [
    "\n  **Picked up:** Cut a   TestFlight `build`\nMore",
    "Picked up: Cut a TestFlight build",
  ],
  ["@Sam nostr:npub1abc @Evie ✳️ **Updates:** __Tests__ passed", "Tests passed"],
  ["⚠️ Issues: `Signing` failed", "Signing failed"],
  ["🙋 **Question:** Which build should ship?", "Which build should ship?"],
  [
    "nostr:npub1abc\n✳️ **Updates:**\n\nThe build uploaded.",
    "The build uploaded.",
  ],
  ["\n ` `\n", ""],
  ["@Sam **Picked up:** inspect signing", "Picked up: inspect signing"],
  ["A sentence with an @mention in it", "A sentence with an @mention in it"],
]) {
  test(`cleanWorkText: ${JSON.stringify(content)}`, () => {
    assert.equal(cleanWorkText(content), expected);
  });
}

test("cleanWorkText caps the plain-text preview at 200 chars", () => {
  assert.equal(cleanWorkText(`**${"a".repeat(250)}**`), `${"a".repeat(199)}…`);
});

for (const text of [
  "Yes",
  "**Okay!**",
  "do option 12",
  "see my message above about the build",
  "[voice] See if this works.",
  "test this build please",
]) {
  test(`short trigger: ${text}`, () =>
    assert.equal(isShortTrigger(text), true));
}
test("a useful multi-word trigger is kept", () => {
  assert.equal(isShortTrigger("Cut a TestFlight build off main"), false);
});

test("replyParentId chooses NIP-10 reply before root before legacy last e tag", () => {
  const tags = [
    ["e", "root", "", "root"],
    ["e", "reply", "", "reply"],
    ["e", "legacy"],
  ];
  assert.equal(replyParentId(tags), "reply");
  assert.equal(replyParentId([tags[0], tags[2]]), "root");
  assert.equal(
    replyParentId([
      ["e", "first"],
      ["e", "last"],
    ]),
    "last",
  );
  assert.equal(replyParentId([]), null);
});

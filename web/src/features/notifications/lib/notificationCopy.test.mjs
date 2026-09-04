import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationCopy } from "./notificationCopy.ts";

function input(overrides = {}) {
  return {
    authorName: "Ada",
    channelName: "general",
    isDm: false,
    content: "ship it",
    channelId: "ch-1",
    ...overrides,
  };
}

test("a channel message names the channel", () => {
  assert.equal(notificationCopy(input()).title, "Ada in #general");
});

test("a DM shows only the sender", () => {
  assert.equal(notificationCopy(input({ isDm: true })).title, "Ada");
});

test("an unknown channel degrades to the sender rather than a raw id", () => {
  assert.equal(notificationCopy(input({ channelName: "" })).title, "Ada");
});

test("a missing sender name degrades to a placeholder", () => {
  assert.equal(
    notificationCopy(input({ authorName: "   ", isDm: true })).title,
    "Someone",
  );
});

test("the body collapses whitespace", () => {
  assert.equal(
    notificationCopy(input({ content: "  two\n\nlines  " })).body,
    "two lines",
  );
});

test("an empty message still says something", () => {
  assert.equal(
    notificationCopy(input({ content: "   " })).body,
    "Sent a message",
  );
});

// 140 is hardcoded rather than read from NOTIFICATION_BODY_MAX so that
// raising the cap fails this test instead of silently moving it.
test("a long body is cut to 140 characters ending in an ellipsis", () => {
  const body = notificationCopy(input({ content: "x".repeat(500) })).body;
  assert.equal(body.length, 140);
  assert.equal(body.at(-1), "…");
});

test("a body just under the cap is untouched", () => {
  const content = "y".repeat(140);
  assert.equal(notificationCopy(input({ content })).body, content);
});

test("the tag groups repeats by channel", () => {
  assert.equal(notificationCopy(input({ channelId: "ch-9" })).tag, "buzz:ch-9");
});

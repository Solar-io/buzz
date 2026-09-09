import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MESSAGE_TOAST_PREVIEW_MAX,
  buildMessageToast,
  shouldToastMessage,
} from "./messageToast.ts";

test("shouldToastMessage: full 16-row truth table", () => {
  // isSelf=true suppresses everything, whatever the other flags say.
  const rows = [
    // [isSelf, isViewingChannel, isDm, isMuted] -> expected
    [true, true, true, true, false],
    [true, true, true, false, false],
    [true, true, false, true, false],
    [true, true, false, false, false],
    [true, false, true, true, false],
    [true, false, true, false, false],
    [true, false, false, true, false],
    [true, false, false, false, false],
    // Viewing the channel suppresses the toast even for DMs.
    [false, true, true, true, false],
    [false, true, true, false, false],
    [false, true, false, true, false],
    [false, true, false, false, false],
    // DMs always toast (mute is a channel-section pref, not a DM one).
    [false, false, true, true, true],
    [false, false, true, false, true],
    // Channels/forums/huddles toast unless muted.
    [false, false, false, true, false],
    [false, false, false, false, true],
  ];
  for (const [isSelf, isViewingChannel, isDm, isMuted, expected] of rows) {
    assert.equal(
      shouldToastMessage({ isSelf, isViewingChannel, isDm, isMuted }),
      expected,
      `isSelf=${isSelf} isViewingChannel=${isViewingChannel} isDm=${isDm} isMuted=${isMuted}`,
    );
  }
});

test("buildMessageToast truncates the preview at the 90-char boundary", () => {
  assert.equal(MESSAGE_TOAST_PREVIEW_MAX, 90);
  const atBound = "a".repeat(90);
  const overBound = "a".repeat(91);
  const underBound = "a".repeat(89);

  const exact = buildMessageToast({
    channelName: "general",
    isDm: false,
    senderName: "Acid Burn",
    preview: atBound,
  });
  assert.equal(exact.description, atBound);

  const over = buildMessageToast({
    channelName: "general",
    isDm: false,
    senderName: "Acid Burn",
    preview: overBound,
  });
  // 89 body chars + the ellipsis = exactly 90.
  assert.equal(over.description, `${"a".repeat(89)}…`);
  assert.equal(over.description.length, 90);

  const under = buildMessageToast({
    channelName: "general",
    isDm: false,
    senderName: "Acid Burn",
    preview: underBound,
  });
  assert.equal(under.description, underBound);
});

test("buildMessageToast collapses whitespace before measuring length", () => {
  const copy = buildMessageToast({
    channelName: "general",
    isDm: false,
    senderName: "Acid Burn",
    preview: `word\n\n\t word ${"b".repeat(100)}`,
  });
  // "word word " (10) + 100 b's collapses to 110 chars -> 89 + ellipsis.
  assert.equal(copy.description, `word word ${"b".repeat(79)}…`);
  assert.equal(copy.description.length, 90);
});

test("buildMessageToast formats names per conversation kind", () => {
  // Channel: "Sender in #name".
  assert.deepEqual(
    buildMessageToast({
      channelName: "general",
      isDm: false,
      senderName: "Acid Burn",
      preview: "hi",
    }),
    { title: "Acid Burn in #general", description: "hi" },
  );
  // Forum rows carry their plain name; the toast keeps the # form the
  // channel header uses (title = "# name" for forums too).
  assert.deepEqual(
    buildMessageToast({
      channelName: "ops-forum",
      isDm: false,
      senderName: "Lord Nikon",
      preview: "hi",
    }),
    { title: "Lord Nikon in #ops-forum", description: "hi" },
  );
  // DM: the sender is the title; the peer/channel name is the fallback.
  assert.deepEqual(
    buildMessageToast({
      channelName: "Phantom Phreak",
      isDm: true,
      senderName: "Phantom Phreak",
      preview: "hi",
    }),
    { title: "Phantom Phreak", description: "hi" },
  );
  assert.deepEqual(
    buildMessageToast({
      channelName: "Phantom Phreak",
      isDm: true,
      senderName: "",
      preview: "hi",
    }),
    { title: "Phantom Phreak", description: "hi" },
  );
  // Channel with an unknown sender falls back to the bare channel name.
  assert.deepEqual(
    buildMessageToast({
      channelName: "general",
      isDm: false,
      senderName: "",
      preview: "hi",
    }),
    { title: "#general", description: "hi" },
  );
  // No usable name at all.
  assert.deepEqual(
    buildMessageToast({
      channelName: "",
      isDm: false,
      senderName: "",
      preview: "hi",
    }),
    { title: "New message", description: "hi" },
  );
});

test("buildMessageToast falls back to copy when the preview is empty", () => {
  const copy = buildMessageToast({
    channelName: "general",
    isDm: false,
    senderName: "Acid Burn",
    preview: "   ",
  });
  assert.equal(copy.description, "Sent a message");
});

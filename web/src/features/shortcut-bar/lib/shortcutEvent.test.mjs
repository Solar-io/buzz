import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KIND_SHORTCUT_BAR,
  SHORTCUT_BAR_D_TAG,
  buildShortcutEventTags,
  isShortcutBarEvent,
  nextShortcutCreatedAt,
  reduceShortcutEvents,
} from "./shortcutEvent.ts";

function event(overrides = {}) {
  return {
    pubkey: "11".repeat(32),
    content: "ciphertext",
    created_at: 1_757_000_000,
    tags: [
      ["d", SHORTCUT_BAR_D_TAG],
      ["t", "shortcut-bar"],
    ],
    ...overrides,
  };
}

test("the kind and coordinate are pinned to the relay's 30078 path", () => {
  assert.equal(KIND_SHORTCUT_BAR, 30078);
  assert.equal(SHORTCUT_BAR_D_TAG, "shortcut-bar");
});

test("publish tags carry d and t, and never h", () => {
  const tags = buildShortcutEventTags();
  assert.deepEqual(tags, [
    ["d", "shortcut-bar"],
    ["t", "shortcut-bar"],
  ]);
  // 30078 is global-only in the relay's ingest path: an `h` tag would get
  // the whole publish REJECTED, so its absence is load-bearing.
  assert.equal(
    tags.some((tag) => tag[0] === "h"),
    false,
  );
});

test("created_at is monotonic against the newest fetched event", () => {
  assert.equal(
    nextShortcutCreatedAt(1_757_000_000, 1_757_000_500),
    1_757_000_500,
  );
  // A clock behind the relay's newest copy is pushed past it.
  assert.equal(
    nextShortcutCreatedAt(1_757_000_000, 1_756_000_000),
    1_757_000_001,
  );
  // Never equal to what was fetched: equal created_at loses the LWW fold's
  // tie to whichever copy arrived first.
  assert.equal(
    nextShortcutCreatedAt(1_757_000_000, 1_757_000_000),
    1_757_000_001,
  );
});

test("the fold is newest-wins regardless of arrival order", () => {
  const older = event({ created_at: 1_757_000_000, content: "older" });
  const newer = event({ created_at: 1_757_000_100, content: "newer" });
  assert.equal(reduceShortcutEvents([older, newer]).content, "newer");
  assert.equal(reduceShortcutEvents([newer, older]).content, "newer");
});

test("an equal created_at keeps the first copy seen", () => {
  const first = event({ created_at: 50, content: "first" });
  const second = event({ created_at: 50, content: "second" });
  assert.equal(reduceShortcutEvents([first, second]).content, "first");
});

test("events on a foreign d coordinate are ignored, not folded", () => {
  const foreign = event({
    created_at: 9_999_999_999,
    tags: [["d", "read-state:main"]],
  });
  const mine = event({ created_at: 50 });
  assert.equal(reduceShortcutEvents([foreign, mine]).created_at, 50);
  assert.equal(reduceShortcutEvents([foreign]), null);
});

test("an empty stream folds to null", () => {
  assert.equal(reduceShortcutEvents([]), null);
});

test("isShortcutBarEvent discriminates on the d tag", () => {
  assert.equal(isShortcutBarEvent(event()), true);
  assert.equal(isShortcutBarEvent(event({ tags: [] })), false);
});

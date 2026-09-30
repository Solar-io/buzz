import assert from "node:assert/strict";
import test from "node:test";

import { liveChannelEventEffects } from "./useLiveChannelUpdates.ts";

const VIEWER = "a".repeat(64);
const AGENT = "b".repeat(64);
const HUMAN = "c".repeat(64);
/** buzz-services reminder identity — the wake sender. */
const WAKE_SERVICE =
  "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271";

const event = (pubkey, tags, kind = 9) => ({ kind, pubkey, tags });

test("a wake for another member does not advance Recent ordering and is not notifiable", () => {
  const effects = liveChannelEventEffects(
    event(WAKE_SERVICE, [
      ["h", "ch"],
      ["p", AGENT],
    ]),
    VIEWER,
    false,
  );
  assert.deepEqual(effects, {
    isUnreadTriggerKind: true,
    advanceRecency: false,
    notifiable: false,
  });
});

test("a wake for another member in a DM is silent too", () => {
  const effects = liveChannelEventEffects(
    event(WAKE_SERVICE, [
      ["h", "dm"],
      ["p", AGENT],
    ]),
    VIEWER,
    true,
  );
  assert.equal(effects.advanceRecency, false);
  assert.equal(effects.notifiable, false);
});

test("an ordinary message advances Recent ordering and is notifiable", () => {
  const effects = liveChannelEventEffects(
    event(HUMAN, [
      ["h", "ch"],
      ["p", AGENT],
    ]),
    VIEWER,
    false,
  );
  assert.deepEqual(effects, {
    isUnreadTriggerKind: true,
    advanceRecency: true,
    notifiable: true,
  });
});

test("a wake that p-tags the viewer advances Recent ordering and is notifiable", () => {
  const effects = liveChannelEventEffects(
    event(WAKE_SERVICE, [
      ["h", "ch"],
      ["p", VIEWER],
    ]),
    VIEWER,
    false,
  );
  assert.equal(effects.advanceRecency, true);
  assert.equal(effects.notifiable, true);
});

test("a service post with no p tag advances Recent ordering and is notifiable", () => {
  const effects = liveChannelEventEffects(
    event(WAKE_SERVICE, [["h", "ch"]]),
    VIEWER,
    false,
  );
  assert.equal(effects.advanceRecency, true);
  assert.equal(effects.notifiable, true);
});

test("a non-content kind never advances Recent ordering", () => {
  const effects = liveChannelEventEffects(
    event(HUMAN, [["h", "ch"]], 7),
    VIEWER,
    false,
  );
  assert.equal(effects.isUnreadTriggerKind, false);
  assert.equal(effects.advanceRecency, false);
});

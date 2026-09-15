import assert from "node:assert/strict";
import { test } from "node:test";
import { decideDefaultConversation } from "./defaultConversation.ts";

const BASE = {
  handled: false,
  userAlreadySelected: false,
  connected: true,
  channelCount: 5,
  samplingSettled: true,
  hardCapElapsed: false,
  visibleDms: [
    { lastActivity: 0 },
    { lastActivity: 1789500000 },
    { lastActivity: 1789400000 },
  ],
};

test("picks the first message-bearing DM once settled", () => {
  assert.deepEqual(decideDefaultConversation(BASE), { action: "open", index: 1 });
});

test("round-3 fix: WAITS past the old 1.2s behavior while the window is unsettled", () => {
  // Cold start, sampling subs unanswered, hard cap NOT yet reached: the
  // pick must hold even though connected + channels exist. Under the old
  // fixed-timer code this exact state opened nothing and left the picker.
  const decision = decideDefaultConversation({ ...BASE, samplingSettled: false });
  assert.equal(decision.action, "wait");
});

test("hard cap frees a dead relay to the picker, never a hang", () => {
  const decision = decideDefaultConversation({
    ...BASE,
    samplingSettled: false,
    hardCapElapsed: true,
    // Unmessaged multi-DM set under the cap-less gate = stand down (picker).
    visibleDms: [
      { lastActivity: 0 },
      { lastActivity: 0 },
    ],
  });
  assert.equal(decision.action, "stand-down");
});

test("hard cap still picks a message-bearing DM if samples did land", () => {
  const decision = decideDefaultConversation({
    ...BASE,
    samplingSettled: false,
    hardCapElapsed: true,
  });
  assert.deepEqual(decision, { action: "open", index: 1 });
});

test("lone visible DM opens even unmessaged", () => {
  const decision = decideDefaultConversation({
    ...BASE,
    visibleDms: [{ lastActivity: 0 }],
  });
  assert.deepEqual(decision, { action: "open", index: 0 });
});

test("no messaged DM and multiple visible DMs stands down (no roulette)", () => {
  const decision = decideDefaultConversation({
    ...BASE,
    visibleDms: [
      { lastActivity: 0 },
      { lastActivity: 0 },
      { lastActivity: 0 },
    ],
  });
  assert.equal(decision.action, "stand-down");
});

test("handled and user-selection retire the pick without opening", () => {
  assert.equal(
    decideDefaultConversation({ ...BASE, handled: true }).action,
    "handled",
  );
  assert.equal(
    decideDefaultConversation({ ...BASE, userAlreadySelected: true }).action,
    "handled",
  );
});

test("waits while disconnected or channel-less regardless of settle", () => {
  assert.equal(
    decideDefaultConversation({ ...BASE, connected: false }).action,
    "wait",
  );
  assert.equal(
    decideDefaultConversation({ ...BASE, channelCount: 0 }).action,
    "wait",
  );
});

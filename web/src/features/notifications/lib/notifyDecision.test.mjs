import assert from "node:assert/strict";
import { test } from "node:test";
import { decideNotification, describeNotifyReason } from "./notifyDecision.ts";

/**
 * A message that IS worth alerting about, so every case below changes exactly
 * one thing. A fixture that already fails some other gate would let a broken
 * rule pass because a different rule stopped it first.
 */
function relevantMessage(overrides = {}) {
  return {
    fromSelf: false,
    mentionsSelf: true,
    isDm: false,
    channelMuted: false,
    isActiveChannel: false,
    ...overrides,
  };
}

function grantedContext(overrides = {}) {
  return {
    mode: "mentions",
    desktopEnabled: true,
    permission: "granted",
    documentHidden: true,
    ...overrides,
  };
}

test("a mention in a hidden tab notifies and badges", () => {
  const decision = decideNotification(relevantMessage(), grantedContext());
  assert.deepEqual(decision, { notify: true, badge: true, reason: "ok" });
});

test("your own message never notifies", () => {
  const decision = decideNotification(
    relevantMessage({ fromSelf: true }),
    grantedContext(),
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.badge, false);
  assert.equal(decision.reason, "self");
});

test('mode "none" silences both outputs', () => {
  const decision = decideNotification(
    relevantMessage(),
    grantedContext({ mode: "none" }),
  );
  assert.deepEqual(decision, {
    notify: false,
    badge: false,
    reason: "muted-everything",
  });
});

test("a muted channel silences both outputs", () => {
  const decision = decideNotification(
    relevantMessage({ channelMuted: true }),
    grantedContext(),
  );
  assert.deepEqual(decision, {
    notify: false,
    badge: false,
    reason: "channel-muted",
  });
});

test('mode "mentions" drops a message that is neither a mention nor a DM', () => {
  const decision = decideNotification(
    relevantMessage({ mentionsSelf: false, isDm: false }),
    grantedContext({ mode: "mentions" }),
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.reason, "not-addressed");
});

test('mode "mentions" keeps a DM that does not mention you', () => {
  const decision = decideNotification(
    relevantMessage({ mentionsSelf: false, isDm: true }),
    grantedContext({ mode: "mentions" }),
  );
  assert.equal(decision.notify, true);
  assert.equal(decision.reason, "ok");
});

test('mode "all" keeps an ordinary channel message', () => {
  const decision = decideNotification(
    relevantMessage({ mentionsSelf: false, isDm: false }),
    grantedContext({ mode: "all" }),
  );
  assert.equal(decision.notify, true);
  assert.equal(decision.reason, "ok");
});

// ── The visibility rule ────────────────────────────────────────────────────
// These four cases are the whole point of the pair (documentHidden,
// isActiveChannel). Inverting the visibility test in the production code
// flips the first two, so both are asserted rather than only the "skip" one:
// a suite that only pins "visible + active ⇒ skip" passes just as happily
// when the rule has become "hidden + active ⇒ skip", which would kill every
// notification for the channel you left open in a backgrounded tab.

test("VISIBLE tab, looking at that channel: no alert", () => {
  const decision = decideNotification(
    relevantMessage({ isActiveChannel: true }),
    grantedContext({ documentHidden: false }),
  );
  assert.deepEqual(decision, {
    notify: false,
    badge: false,
    reason: "viewing",
  });
});

test("HIDDEN tab with that channel still selected: alert anyway", () => {
  const decision = decideNotification(
    relevantMessage({ isActiveChannel: true }),
    grantedContext({ documentHidden: true }),
  );
  assert.deepEqual(decision, { notify: true, badge: true, reason: "ok" });
});

test("VISIBLE tab, a different channel: notifies but does not badge", () => {
  const decision = decideNotification(
    relevantMessage({ isActiveChannel: false }),
    grantedContext({ documentHidden: false }),
  );
  assert.equal(decision.notify, true);
  assert.equal(decision.badge, false, "a visible tab shows no title badge");
});

test("HIDDEN tab, a different channel: alert", () => {
  const decision = decideNotification(
    relevantMessage({ isActiveChannel: false }),
    grantedContext({ documentHidden: true }),
  );
  assert.deepEqual(decision, { notify: true, badge: true, reason: "ok" });
});

// ── Permission and the master switch ───────────────────────────────────────
// Each of these must leave `badge` TRUE: the tab badge is ours to draw and
// must survive a browser that will never let us pop a notification.

test("permission denied blocks the notification but keeps the badge", () => {
  const decision = decideNotification(
    relevantMessage(),
    grantedContext({ permission: "denied" }),
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.badge, true);
  assert.equal(decision.reason, "permission-denied");
});

test("permission never asked blocks the notification but keeps the badge", () => {
  const decision = decideNotification(
    relevantMessage(),
    grantedContext({ permission: "default" }),
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.badge, true);
  assert.equal(decision.reason, "permission-default");
});

test("a browser without the API blocks the notification but keeps the badge", () => {
  const decision = decideNotification(
    relevantMessage(),
    grantedContext({ permission: "unsupported" }),
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.badge, true);
  assert.equal(decision.reason, "unsupported");
});

test("the master switch blocks the notification but keeps the badge", () => {
  const decision = decideNotification(
    relevantMessage(),
    grantedContext({ desktopEnabled: false }),
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.badge, true);
  assert.equal(decision.reason, "notifications-off");
});

test("every reason has copy", () => {
  const reasons = [
    "ok",
    "self",
    "muted-everything",
    "channel-muted",
    "not-addressed",
    "viewing",
    "notifications-off",
    "permission-default",
    "permission-denied",
    "unsupported",
  ];
  assert.equal(reasons.length, 10);
  for (const reason of reasons) {
    const copy = describeNotifyReason(reason);
    assert.equal(typeof copy, "string");
    assert.ok(copy.length > 0, `no copy for ${reason}`);
  }
});

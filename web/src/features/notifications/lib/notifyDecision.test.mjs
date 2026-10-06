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
    soundEnabled: true,
    ...overrides,
  };
}

test("a mention in a hidden tab notifies and badges", () => {
  const decision = decideNotification(relevantMessage(), grantedContext());
  assert.deepEqual(decision, {
    notify: true,
    badge: true,
    sound: true,
    reason: "ok",
  });
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
    sound: false,
    reason: "muted-everything",
  });
});

// ── Mute means count, never alert (Sam, 2026-10-06) ───────────────────────
// A muted conversation still counts toward the badge, but raises no
// notification and no sound.
// Each muted case is paired with its unmuted control so a rule that silences
// everyone cannot pass.

test("a muted conversation still badges, but raises no notification and no sound", () => {
  const decision = decideNotification(
    relevantMessage({ channelMuted: true }),
    grantedContext(),
  );
  assert.deepEqual(decision, {
    notify: false,
    badge: true,
    sound: false,
    reason: "channel-muted",
  });
});

test("a muted conversation in a visible tab does not badge (the sidebar shows it)", () => {
  const decision = decideNotification(
    relevantMessage({ channelMuted: true }),
    grantedContext({ documentHidden: false }),
  );
  assert.equal(decision.badge, false);
  assert.equal(decision.notify, false);
  assert.equal(decision.sound, false);
});

test("control: the same message unmuted plays a sound", () => {
  const decision = decideNotification(
    relevantMessage({ channelMuted: false }),
    grantedContext(),
  );
  assert.equal(decision.sound, true);
});

test("a muted @mention in mode all counts but does not alert either", () => {
  const decision = decideNotification(
    relevantMessage({ channelMuted: true, mentionsSelf: true }),
    grantedContext({ mode: "all" }),
  );
  assert.equal(decision.notify, false);
  assert.equal(decision.badge, true);
  assert.equal(decision.sound, false);
});

test("a muted DM only counts; an unmuted DM notifies and chimes", () => {
  const muted = decideNotification(
    relevantMessage({ channelMuted: true, isDm: true, mentionsSelf: false }),
    grantedContext(),
  );
  const unmuted = decideNotification(
    relevantMessage({ channelMuted: false, isDm: true, mentionsSelf: false }),
    grantedContext(),
  );
  assert.equal(muted.notify, false);
  assert.equal(muted.badge, true);
  assert.equal(muted.sound, false);
  assert.equal(unmuted.notify, true);
  assert.equal(unmuted.sound, true);
});

test("a muted channel still obeys mode mentions (not addressed → nothing)", () => {
  const decision = decideNotification(
    relevantMessage({ channelMuted: true, mentionsSelf: false }),
    grantedContext({ mode: "mentions" }),
  );
  assert.deepEqual(decision, {
    notify: false,
    badge: false,
    sound: false,
    reason: "not-addressed",
  });
});

test("the muted reason says it counts but never alerts", () => {
  assert.equal(
    describeNotifyReason("channel-muted"),
    "That conversation is muted: it counts as unread but never alerts.",
  );
});

// ── Sound gates ────────────────────────────────────────────────────────────

test("sounds switched off: notifies, no sound", () => {
  const decision = decideNotification(
    relevantMessage(),
    grantedContext({ soundEnabled: false }),
  );
  assert.equal(decision.notify, true);
  assert.equal(decision.sound, false);
});

test("viewing the channel: no sound", () => {
  const decision = decideNotification(
    relevantMessage({ isActiveChannel: true }),
    grantedContext({ documentHidden: false }),
  );
  assert.equal(decision.sound, false);
});

test("visible tab on ANOTHER channel still plays a sound", () => {
  const decision = decideNotification(
    relevantMessage({ isActiveChannel: false }),
    grantedContext({ documentHidden: false }),
  );
  assert.equal(decision.sound, true);
});

test('mode "none": no sound', () => {
  const decision = decideNotification(
    relevantMessage(),
    grantedContext({ mode: "none" }),
  );
  assert.equal(decision.sound, false);
});

test("your own message: no sound", () => {
  assert.equal(
    decideNotification(relevantMessage({ fromSelf: true }), grantedContext())
      .sound,
    false,
  );
});

test("a silent wake: no sound", () => {
  assert.equal(
    decideNotification(
      relevantMessage({ silentWake: true }),
      grantedContext({ mode: "all" }),
    ).sound,
    false,
  );
});

test("sound does not depend on permission or the desktop switch", () => {
  for (const context of [
    { permission: "denied" },
    { permission: "default" },
    { permission: "unsupported" },
    { desktopEnabled: false },
  ]) {
    const decision = decideNotification(
      relevantMessage(),
      grantedContext(context),
    );
    assert.equal(decision.notify, false, JSON.stringify(context));
    assert.equal(decision.sound, true, JSON.stringify(context));
  }
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
    sound: false,
    reason: "viewing",
  });
});

test("HIDDEN tab with that channel still selected: alert anyway", () => {
  const decision = decideNotification(
    relevantMessage({ isActiveChannel: true }),
    grantedContext({ documentHidden: true }),
  );
  assert.deepEqual(decision, {
    notify: true,
    badge: true,
    sound: true,
    reason: "ok",
  });
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
  assert.deepEqual(decision, {
    notify: true,
    badge: true,
    sound: true,
    reason: "ok",
  });
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

test("a silent wake neither notifies nor badges, even in mode all with a hidden granted tab", () => {
  const decision = decideNotification(
    relevantMessage({ mentionsSelf: false, silentWake: true }),
    grantedContext({
      mode: "all",
      documentHidden: true,
      permission: "granted",
    }),
  );
  assert.deepEqual(decision, {
    notify: false,
    badge: false,
    sound: false,
    reason: "silent-wake",
  });
});

test("the silent-wake reason has its own copy", () => {
  assert.equal(
    describeNotifyReason("silent-wake"),
    "Scheduled wakes for other members never notify.",
  );
});

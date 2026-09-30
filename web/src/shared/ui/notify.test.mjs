import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentDoneSpec,
  feedbackDueSpec,
  messageSpec,
  needsYouSpec,
  sendErrorSpec,
} from "./notify.ts";

/** Toast variants (phase-1 §5). Durations are hardcoded here on purpose. */

const noop = () => {};

test("sendError shows result.message verbatim and never auto-dismisses", () => {
  // Leading space, trailing newline and well over 80 chars: any trimming or
  // truncation of the relay's verdict changes this string.
  const verdict =
    "  invalid: root tag does not match thread ancestry (reply to 4f2a… under root 9b1c…, expected root 77e0…)\n";
  const spec = sendErrorSpec({ message: verdict, onRetry: noop, onCopy: noop });
  assert.equal(spec.meta, verdict);
  assert.equal(spec.duration, Number.POSITIVE_INFINITY);
  assert.equal(spec.timer, false, "a sticky toast draws no timer");
  assert.equal(spec.role, "alert");
  assert.deepEqual(
    spec.actions.map((action) => [action.label, action.primary === true]),
    [
      ["Retry", true],
      ["Copy error", false],
    ],
  );
});

test("message and agentDone dismiss at 6000 ms", () => {
  const message = messageSpec({
    sender: "Gilfoyle",
    senderPubkey: "aa".repeat(32),
    agent: true,
    context: "DM · now",
    preview: "Unblinded, and it's an upset.",
    onReply: noop,
    onFeedback: noop,
  });
  const done = agentDoneSpec({
    agent: "Acid Burn",
    meta: "#engineering · end_turn",
    onOpen: noop,
  });
  for (const spec of [message, done]) {
    assert.equal(spec.duration, 6000, spec.variant);
    assert.equal(spec.timer, true, `${spec.variant} draws the timer line`);
  }
  // Toasts artboard: a message offers Reply and Feedback (Phase 2 shipped
  // both); a finished turn only opens.
  assert.deepEqual(
    message.actions.map((action) => action.label),
    ["Reply", "Feedback"],
  );
  assert.deepEqual(
    done.actions.map((action) => action.label),
    ["Open"],
  );
  // No reminders here, no Feedback button — no control that lies.
  const bare = messageSpec({
    sender: "Gilfoyle",
    senderPubkey: "aa".repeat(32),
    agent: true,
    context: "DM · now",
    preview: "x",
    onReply: noop,
  });
  assert.deepEqual(
    bare.actions.map((action) => action.label),
    ["Reply"],
  );
  // The decision toasts stay until acted on.
  const needs = needsYouSpec({
    lead: "Cereal Killer",
    rest: "needs your approval",
    meta: "merge fix(web) · #engineering",
    seed: "cc".repeat(32),
    agent: true,
    primary: { label: "Approve", onClick: noop },
    secondary: { label: "Review", onClick: noop },
  });
  const feedback = feedbackDueSpec({
    context: "ESP32",
    body: "Pick a wake word before audio tuning.",
    ai: true,
    onOpen: noop,
    onSnooze: noop,
  });
  for (const spec of [needs, feedback]) {
    assert.equal(spec.duration, Number.POSITIVE_INFINITY, spec.variant);
    assert.equal(spec.timer, false);
  }
});

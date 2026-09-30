import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldToastNeed } from "./needsToast.ts";

const open = { settled: true, workVisible: false, selectedId: "ch-other" };

test("an ask in the conversation I am reading raises no toast", () => {
  const ask = { kind: "ask", channelId: "ch-reading" };
  assert.equal(
    shouldToastNeed(ask, { ...open, selectedId: "ch-reading" }),
    false,
    "the row is already on screen",
  );
  // The same ask, read from elsewhere, does.
  assert.equal(shouldToastNeed(ask, open), true);
  // An approval there is the same case.
  assert.equal(
    shouldToastNeed(
      { kind: "approval", channelId: "ch-reading" },
      { ...open, selectedId: "ch-reading" },
    ),
    false,
  );
});

test("a channel-less approval toasts whatever is open", () => {
  const approval = { kind: "approval", channelId: null };
  assert.equal(shouldToastNeed(approval, { ...open, selectedId: null }), true);
  assert.equal(shouldToastNeed(approval, open), true);
});

test("history, a Work surface on screen, mentions and feedback stay quiet", () => {
  const ask = { kind: "ask", channelId: "ch-a" };
  assert.equal(shouldToastNeed(ask, { ...open, settled: false }), false);
  assert.equal(shouldToastNeed(ask, { ...open, workVisible: true }), false);
  assert.equal(
    shouldToastNeed({ kind: "mention", channelId: "ch-a" }, open),
    false,
  );
  assert.equal(
    shouldToastNeed({ kind: "feedback", channelId: "ch-a" }, open),
    false,
  );
});

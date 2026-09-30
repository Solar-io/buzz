import assert from "node:assert/strict";
import test from "node:test";

import {
  decisionToastSuppressed,
  reportWorkPage,
  stackHeaderTop,
  visibleToastLimit,
  workPageOnScreen,
} from "./toastStack.ts";

test("a phone shows one toast; Work on screen suppresses needs-you and feedback-due", () => {
  // Hardcoded limits — never the constants they pin.
  assert.equal(visibleToastLimit(false), 3);
  assert.equal(visibleToastLimit(true), 1);

  const desktopRail = { workVisible: true, workPage: false, phone: false };
  const phoneWork = { workVisible: true, workPage: true, phone: true };
  const phoneChannel = { workVisible: false, workPage: false, phone: true };
  const desktopFolded = { workVisible: false, workPage: false, phone: false };

  // needs-you: down whenever a Work surface shows the row.
  assert.equal(decisionToastSuppressed("needsYou", desktopRail), true);
  assert.equal(decisionToastSuppressed("needsYou", phoneWork), true);
  assert.equal(decisionToastSuppressed("needsYou", phoneChannel), false);
  assert.equal(decisionToastSuppressed("needsYou", desktopFolded), false);

  // feedback-due: down only over the phone's Work page. A reminder still
  // interrupts a desktop reader whose rail happens to be open.
  assert.equal(decisionToastSuppressed("feedbackDue", phoneWork), true);
  assert.equal(decisionToastSuppressed("feedbackDue", desktopRail), false);
  assert.equal(decisionToastSuppressed("feedbackDue", phoneChannel), false);
  assert.equal(
    decisionToastSuppressed("feedbackDue", {
      workVisible: true,
      workPage: true,
      phone: false,
    }),
    false,
  );
});

test("the stack header sits under the lowest visible toast", () => {
  assert.equal(stackHeaderTop([166, 262, 214], 10), 272);
  assert.equal(stackHeaderTop([120], 10), 130);
  // No visible toast, no stack to sit under.
  assert.equal(stackHeaderTop([], 10), null);
});

test("the Work page flag counts mounts, so a remount cannot strand it", () => {
  assert.equal(workPageOnScreen(), false);
  const first = reportWorkPage();
  // The new mount reports before the old one cleans up.
  const second = reportWorkPage();
  first();
  assert.equal(workPageOnScreen(), true);
  // A double cleanup must not drive the counter negative.
  first();
  assert.equal(workPageOnScreen(), true);
  second();
  assert.equal(workPageOnScreen(), false);
});

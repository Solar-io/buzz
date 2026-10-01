import assert from "node:assert/strict";
import { test } from "node:test";

import {
  phoneTabBarVisible,
  viewOwnsPhoneScreen,
} from "@/shared/layout/phoneTabs.ts";
import {
  createHardwareKeyboardLatch,
  inputModeFor,
  reduceSmartPeriod,
  shouldFocusTerminal,
} from "./device.ts";
import {
  contrastRatio,
  makeBoxGlyphFg,
  parseCssColor,
} from "./glyphContrast.ts";
import { buildTermTheme, hslTripleToHex } from "./theme.ts";
import { drainNotches, NOTCH_FALLBACK_PX, resolveNotchPx } from "./touch.ts";

/** The carried evie rules (ADR-032 touch, ADR-059 F2 focus, smart period, box glyphs). */

test("touch: a degenerate screen never yields a zero notch (an infinite drain)", () => {
  assert.equal(resolveNotchPx(0, 30), NOTCH_FALLBACK_PX);
  assert.equal(resolveNotchPx(600, 0), NOTCH_FALLBACK_PX);
  assert.equal(resolveNotchPx(Number.NaN, 30), NOTCH_FALLBACK_PX);
  assert.equal(resolveNotchPx(600, 30), 20);
  assert.equal(resolveNotchPx(100, 100), 8, "clamped to the minimum");
});

test("touch: the remainder is carried and the burst is capped", () => {
  assert.deepEqual(drainNotches(45, 20), { dir: 1, count: 2, accum: 5 });
  assert.deepEqual(drainNotches(-45, 20), { dir: -1, count: 2, accum: -5 });
  assert.deepEqual(drainNotches(1000, 20, 8), { dir: 1, count: 8, accum: 840 });
  assert.deepEqual(drainNotches(10, 0), { dir: 0, count: 0, accum: 10 });
});

test("F2: a finger device focuses only on request or with a proven keyboard", () => {
  assert.equal(
    shouldFocusTerminal({
      coarse: false,
      hardwareKeyboard: false,
      softKeyboardRequested: false,
    }),
    true,
  );
  assert.equal(
    shouldFocusTerminal({
      coarse: true,
      hardwareKeyboard: false,
      softKeyboardRequested: false,
    }),
    false,
  );
  assert.equal(
    shouldFocusTerminal({
      coarse: true,
      hardwareKeyboard: true,
      softKeyboardRequested: false,
    }),
    true,
  );
  assert.equal(
    inputModeFor({
      coarse: true,
      hardwareKeyboard: true,
      softKeyboardRequested: false,
    }),
    "none",
  );
  assert.equal(
    inputModeFor({
      coarse: true,
      hardwareKeyboard: false,
      softKeyboardRequested: true,
    }),
    "text",
  );
});

test("a hardware keyboard is proven by a trusted key with nothing editable focused", () => {
  let detected = 0;
  const latch = createHardwareKeyboardLatch(() => {
    detected += 1;
  });
  assert.equal(
    latch.observe({ isTrusted: true, key: "a", keyCode: 229 }, null),
    false,
    "IME sentinel",
  );
  assert.equal(
    latch.observe({ isTrusted: true, key: "a" }, { tagName: "TEXTAREA" }),
    false,
  );
  assert.equal(latch.observe({ isTrusted: false, key: "a" }, null), false);
  assert.equal(
    latch.observe({ isTrusted: true, key: "a" }, { tagName: "BODY" }),
    true,
  );
  assert.equal(
    latch.observe({ isTrusted: true, key: "b" }, null),
    false,
    "sticky: once",
  );
  assert.equal(detected, 1);
});

test("smart period: two spaces within a second on a finger device → DEL + '. '", () => {
  const first = reduceSmartPeriod(null, " ", 1_000, true);
  assert.deepEqual(first, { data: " ", lastSpaceAt: 1_000 });
  assert.deepEqual(reduceSmartPeriod(first.lastSpaceAt, " ", 1_400, true), {
    data: "\x7f. ",
    lastSpaceAt: null,
  });
  assert.equal(
    reduceSmartPeriod(1_000, " ", 2_500, true).data,
    " ",
    "too slow",
  );
  assert.equal(
    reduceSmartPeriod(1_000, " ", 1_400, false).data,
    " ",
    "desktop untouched",
  );
  assert.equal(
    reduceSmartPeriod(1_000, "  ", 1_400, true).data,
    "  ",
    "a paste untouched",
  );
});

test("box glyphs painted in the background colour are lifted to 2.1:1; others pass", () => {
  const lift = makeBoxGlyphFg({ background: "#101010", minContrast: 2.1 });
  const lifted = lift("#141414");
  assert.notEqual(lifted, "#141414");
  const ratio = contrastRatio(parseCssColor(lifted), parseCssColor("#101010"));
  assert.ok(ratio >= 2.1 && ratio < 2.2, `ratio ${ratio}`);
  assert.equal(lift("#9399b2"), "#9399b2", "a visible border is left alone");
});

test("theme: Buzz tokens feed xterm, coral ink converts from its HSL triple", () => {
  assert.equal(hslTripleToHex("9.7 72.34% 36.9%"), "#a2301a");
  const theme = buildTermTheme(
    {
      background: "#101010",
      foreground: "#d8d6d1",
      dim: "#8a8781",
      green: "#8ccba5",
      blue: "#a5bedf",
      yellow: "#d9b56a",
      red: "#e39a8a",
    },
    true,
  );
  assert.equal(theme.background, "#101010");
  assert.equal(theme.cursor, "#d8d6d1");
  assert.equal(theme.green, "#8ccba5");
  assert.equal(theme.brightBlack, "#8a8781");
  assert.equal(theme.red, "#e39a8a");
});

test("the Terminal owns the phone screen: the tab bar steps aside for it alone", () => {
  assert.equal(viewOwnsPhoneScreen("terminal"), true);
  for (const view of [undefined, "work", "channels", "inbox", "reminders"]) {
    assert.equal(viewOwnsPhoneScreen(view), false, String(view));
  }
  // The tab-page rule itself is unchanged.
  assert.equal(
    phoneTabBarVisible({
      conversationOpen: false,
      view: "terminal",
      webLayerActive: false,
    }),
    true,
  );
});

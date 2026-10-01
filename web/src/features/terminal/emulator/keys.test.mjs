import assert from "node:assert/strict";
import { test } from "node:test";

import {
  barKeyBytes,
  barKeyRepeats,
  createCtrlLatch,
  ctrlByte,
  herdrCmdSeqFor,
  shiftEnterSeqFor,
} from "./keys.ts";

/** W-7: the key bar's exact bytes, including the ctrl latch. Hardcoded. */

const plain = { ctrl: false, appCursor: false };

test("esc and tab are single bytes", () => {
  assert.equal(barKeyBytes("esc", plain), "\x1b");
  assert.equal(barKeyBytes("tab", plain), "\t");
  assert.equal(barKeyBytes("esc", { ctrl: true, appCursor: true }), "\x1b");
});

test("arrows: CSI normally, SS3 under DECCKM (application cursor keys)", () => {
  assert.deepEqual(
    ["up", "down", "right", "left"].map((k) => barKeyBytes(k, plain)),
    ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"],
  );
  assert.deepEqual(
    ["up", "down", "right", "left"].map((k) =>
      barKeyBytes(k, { ctrl: false, appCursor: true }),
    ),
    ["\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD"],
  );
});

test("ctrl+arrow is CSI 1;5, whatever DECCKM says", () => {
  assert.equal(
    barKeyBytes("left", { ctrl: true, appCursor: false }),
    "\x1b[1;5D",
  );
  assert.equal(barKeyBytes("up", { ctrl: true, appCursor: true }), "\x1b[1;5A");
});

test("arrows repeat on hold; esc and tab do not", () => {
  assert.deepEqual(
    ["esc", "tab", "up", "down", "left", "right"].map(barKeyRepeats),
    [false, false, true, true, true, true],
  );
});

test("ctrl bytes: letters, the @[\\]^_ row, space and ?", () => {
  assert.equal(ctrlByte("c"), "\x03");
  assert.equal(ctrlByte("C"), "\x03");
  assert.equal(ctrlByte("a"), "\x01");
  assert.equal(ctrlByte("z"), "\x1a");
  assert.equal(ctrlByte("["), "\x1b");
  assert.equal(ctrlByte("@"), "\x00");
  assert.equal(ctrlByte(" "), "\x00");
  assert.equal(ctrlByte("?"), "\x7f");
  assert.equal(ctrlByte("5"), null);
  assert.equal(ctrlByte("ab"), null);
});

test("the ctrl latch arms once, applies to the NEXT key only, then clears", () => {
  const changes = [];
  const latch = createCtrlLatch((armed) => changes.push(armed));
  assert.equal(latch.apply("c"), "c", "unarmed: unchanged");
  assert.equal(latch.toggle(), true);
  assert.equal(latch.apply("c"), "\x03", "ctrl+c = ETX, the interrupt");
  assert.equal(latch.armed, false);
  assert.equal(latch.apply("c"), "c", "consumed");
  latch.toggle();
  assert.equal(latch.apply("5"), "5", "no ctrl form: sent as typed");
  assert.equal(latch.armed, false, "…and the latch still drops");
  latch.toggle();
  assert.equal(latch.takeForBarKey(), true);
  assert.equal(latch.takeForBarKey(), false);
  latch.toggle();
  latch.toggle();
  assert.equal(latch.armed, false, "a second press disarms");
  assert.deepEqual(changes, [
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
});

test("bare Cmd+K / Cmd+J become herdr's CSI-u SUPER chords; anything else is left alone", () => {
  const key = (k, mods = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  assert.equal(herdrCmdSeqFor(key("k", { metaKey: true })), "\x1b[107;9u");
  assert.equal(herdrCmdSeqFor(key("j", { metaKey: true })), "\x1b[106;9u");
  assert.equal(
    herdrCmdSeqFor(key("k", { metaKey: true, shiftKey: true })),
    null,
  );
  assert.equal(herdrCmdSeqFor(key("k", { ctrlKey: true })), null);
  assert.equal(herdrCmdSeqFor(key("x", { metaKey: true })), null);
  assert.equal(shiftEnterSeqFor(key("Enter", { shiftKey: true })), "\x1b\r");
  assert.equal(shiftEnterSeqFor(key("Enter")), null);
  assert.equal(
    shiftEnterSeqFor(key("Enter", { shiftKey: true, metaKey: true })),
    null,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backoffDelayMs,
  closeAction,
  mintTermId,
  resizeFrame,
  termId,
} from "./protocol.ts";

/**
 * W-2 (phase-7.md §5.1): the close-code table. Expected actions are written
 * out, never derived from the module's constants.
 */

const opened = { opened: true, resetting: false };

test("4002 soft reset: reconnect with the same id (wins even before open)", () => {
  assert.deepEqual(closeAction(4002, opened), { kind: "soft-reset" });
  assert.deepEqual(closeAction(4002, { opened: false, resetting: false }), {
    kind: "soft-reset",
  });
});

test("4001 hard reset, or a reset we asked for that closed otherwise: rotate", () => {
  assert.deepEqual(closeAction(4001, opened), { kind: "hard-reset" });
  assert.deepEqual(closeAction(1006, { opened: true, resetting: true }), {
    kind: "hard-reset",
  });
});

test("4004 kill switch: disabled, no reconnect", () => {
  assert.deepEqual(closeAction(4004, opened), {
    kind: "stop",
    state: "disabled",
  });
});

test("never opened: diagnose (retry quietly and ask hatch why)", () => {
  assert.deepEqual(closeAction(1006, { opened: false, resetting: false }), {
    kind: "diagnose",
  });
  // A refused upgrade must not read as "shell exited" or "at capacity".
  assert.deepEqual(closeAction(1000, { opened: false, resetting: false }), {
    kind: "diagnose",
  });
});

test("1013 capacity, 1011 spawn failure, 1000 exit: terminal states, no reconnect", () => {
  assert.deepEqual(closeAction(1013, opened), {
    kind: "stop",
    state: "at-capacity",
  });
  assert.deepEqual(closeAction(1011, opened), {
    kind: "stop",
    state: "failed",
  });
  assert.deepEqual(closeAction(1000, opened), {
    kind: "stop",
    state: "shell-exited",
  });
});

test("4003 herdr client exited, 1006 drop: back off and reconnect", () => {
  assert.deepEqual(closeAction(4003, opened), { kind: "reconnect" });
  assert.deepEqual(closeAction(1006, opened), { kind: "reconnect" });
  assert.deepEqual(closeAction(1001, opened), { kind: "reconnect" });
});

test("backoff: 0.5 → 1 → 2 → 4 → 8 s, then held at 8 s", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 20].map(backoffDelayMs),
    [500, 1000, 2000, 4000, 8000, 8000, 8000],
  );
});

test("the client id is minted in herdr's charset and persisted", () => {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  const id = termId(storage);
  assert.match(id, /^t-[0-9a-f]{16}$/);
  assert.equal(store.get("buzz.terminal.id"), id);
  assert.equal(termId(storage), id, "stable until rotated");
  const next = mintTermId(storage);
  assert.notEqual(next, id);
  assert.equal(termId(storage), next);
  store.set("buzz.terminal.id", "bad id with spaces");
  assert.match(
    termId(storage),
    /^t-[0-9a-f]{16}$/,
    "an invalid stored id is replaced",
  );
});

test("resize frames are text JSON, and degenerate sizes send nothing", () => {
  assert.equal(resizeFrame(120, 40), '{"type":"resize","cols":120,"rows":40}');
  assert.equal(resizeFrame(0, 40), null);
  assert.equal(resizeFrame(120, Number.NaN), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { ACK_TIMEOUT_MS, pendingRowState } from "./pendingCommands.ts";

test("an ok ack is applied; an error ack is error — never timed out", () => {
  assert.deepEqual(pendingRowState(1_000, { ok: true }, 999_999), {
    status: "applied",
    timedOut: false,
  });
  assert.deepEqual(pendingRowState(1_000, { ok: false }, 999_999), {
    status: "error",
    timedOut: false,
  });
});

test("no ack before the threshold stays sent; past it flips to unknown", () => {
  const sentAt = 100_000;
  // One tick BEFORE the threshold.
  assert.deepEqual(pendingRowState(sentAt, undefined, sentAt + 20_000), {
    status: "sent",
    timedOut: false,
  });
  // One tick AFTER the threshold — the "?" state the user must actually see.
  assert.deepEqual(pendingRowState(sentAt, undefined, sentAt + 20_001), {
    status: "unknown",
    timedOut: true,
  });
  // Much later (inside the 4x prune window) it stays unknown.
  assert.deepEqual(pendingRowState(sentAt, undefined, sentAt + 79_000), {
    status: "unknown",
    timedOut: true,
  });
});

test("the threshold is pinned at 20 seconds", () => {
  // A raised/lowered constant must be a deliberate act that fails this.
  assert.equal(ACK_TIMEOUT_MS, 20_000);
});

test("a late ack wins over an elapsed timeout", () => {
  // The desktop acked at 60s: the row must read applied, not unknown.
  assert.deepEqual(pendingRowState(100_000, { ok: true }, 160_000), {
    status: "applied",
    timedOut: false,
  });
});

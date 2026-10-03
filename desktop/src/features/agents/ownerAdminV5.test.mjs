import assert from "node:assert/strict";
import test from "node:test";
import { executeOwnerAdminCommand } from "./ownerAdminProtocolV5.ts";
import { serializeOwnerAdminAck } from "../../shared/api/ownerAdminAck.ts";

const NOW = Date.parse("2026-10-02T21:00:00Z");
const create = {
  action: "create",
  requestId: "r",
  name: "Test",
  systemPrompt: "Test",
  issuedAt: "2026-10-02T21:00:00Z",
};

test("requires an unknown cap → ack unsupported and createManagedAgent not called", async () => {
  let calls = 0;
  const createManagedAgent = async () => {
    calls++;
    return "aa".repeat(32);
  };
  const ack = await executeOwnerAdminCommand(
    { ...create, requires: ["update.effort"] },
    createManagedAgent,
    "crichton.local",
    { claim: () => true },
    NOW,
  );
  assert.equal(ack.code, "unsupported");
  assert.equal(ack.ok, false);
  assert.equal(calls, 0);
});

test("stale issuedAt → stale, applier not called", async () => {
  for (const issuedAt of [
    "2026-10-02T20:54:59Z",
    "2026-10-02T21:01:01Z",
    "bad",
    undefined,
  ]) {
    let calls = 0;
    const ack = await executeOwnerAdminCommand(
      { ...create, issuedAt },
      async () => {
        calls++;
        return null;
      },
      "crichton.local",
      { claim: () => true },
      NOW,
    );
    assert.equal(ack.code, "stale", String(issuedAt));
    assert.equal(calls, 0);
  }
});

test("fresh boundaries apply through the existing save path", async () => {
  for (const issuedAt of ["2026-10-02T20:55:00Z", "2026-10-02T21:01:00Z"]) {
    let calls = 0;
    const ack = await executeOwnerAdminCommand(
      { ...create, issuedAt, requires: ["fresh"] },
      async () => {
        calls++;
        return "aa".repeat(32);
      },
      "crichton.local",
      { claim: () => true },
      NOW,
    );
    assert.equal(ack.ok, true);
    assert.equal(calls, 1);
  }
});

test("ping acks caps", async () => {
  let calls = 0;
  const ack = await executeOwnerAdminCommand(
    { action: "ping", requestId: "r", requires: ["ping"] },
    async () => {
      calls++;
      return null;
    },
    "crichton.local",
    { claim: () => true },
    NOW,
  );
  assert.deepEqual(ack.result, {
    catalogVersion: 5,
    caps: ["ping", "ack.result", "requires", "fresh"],
    machine: "crichton.local",
    now: "2026-10-02T21:00:00.000Z",
  });
  assert.equal(calls, 0);
});

test("applier errors produce a failed ack with the original error", async () => {
  const ack = await executeOwnerAdminCommand(
    create,
    async () => {
      throw new Error("save refused");
    },
    "crichton.local",
    { claim: () => true },
    NOW,
  );
  assert.equal(ack.code, "failed");
  assert.equal(ack.error, "save refused");
});

test("ack result survives serialization and oversized UTF-8 result is refused", () => {
  const ack = {
    requestId: "r",
    ok: true,
    code: "started",
    result: { text: "é".repeat(30_000) },
  };
  const parsed = JSON.parse(serializeOwnerAdminAck(ack));
  assert.equal(parsed.code, "too_large");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.result, undefined);
  assert.ok(
    new TextEncoder().encode(serializeOwnerAdminAck(ack)).length < 60_000,
  );
  assert.deepEqual(
    JSON.parse(serializeOwnerAdminAck({ ...ack, result: { n: 1 } })).result,
    { n: 1 },
  );
});

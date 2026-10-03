import assert from "node:assert/strict";
import test from "node:test";
import { capsFor, hasCap } from "./desktopCaps.ts";
import { adminCommandLock } from "./adminCommandLock.ts";

const catalog = {
  machine: "crichton.local",
  version: 5,
  caps: ["ping", "fresh"],
  agents: ["aa".repeat(32)],
  harnesses: [],
  updatedAt: 1,
};

test("v4 catalog has no caps even if caps array present", () => {
  assert.equal(hasCap({ ...catalog, version: 4 }, "ping"), false);
  assert.deepEqual(
    capsFor([{ ...catalog, version: 4 }], { machines: [catalog.machine] }),
    [],
  );
});
test("two machines, one lacks cap → locked", () => {
  const second = { ...catalog, machine: "other", caps: ["ping"] };
  assert.deepEqual(
    capsFor([catalog, second], { machines: [catalog.machine, "other"] }),
    ["ping"],
  );
  assert.deepEqual(
    capsFor([catalog], { machines: [catalog.machine, "missing"] }),
    [],
  );
  assert.deepEqual(capsFor([catalog], { machines: [] }), []);
});
test("offline admin commands are refused before queueing; unsupported requirements lock online machines", () => {
  const command = { action: "start", request: { pubkey: "aa".repeat(32) } };
  const presence = new Map([
    [catalog.machine, { status: "offline", lastSeen: 1, missed: 2 }],
  ]);
  assert.equal(
    adminCommandLock(command, undefined, [catalog], presence).locked,
    true,
  );
  presence.set(catalog.machine, { status: "online", lastSeen: 1, missed: 0 });
  assert.equal(
    adminCommandLock(command, undefined, [catalog], presence).locked,
    false,
  );
  assert.equal(
    adminCommandLock(
      command,
      { requires: ["update.effort"] },
      [catalog],
      presence,
    ).locked,
    true,
  );
  assert.equal(
    adminCommandLock(command, { target: "missing" }, [catalog], presence)
      .locked,
    true,
  );
});

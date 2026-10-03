import assert from "node:assert/strict";
import { test } from "node:test";
import { executeOwnerAdminCommand } from "./ownerAdminProtocolV5.ts";
import { ownerAdminReplayStore } from "./ownerAdminReplay.ts";

const NOW = Date.parse("2026-10-03T14:00:00Z");
const command = {
  action: "create",
  requestId: "original",
  name: "Test",
  systemPrompt: "Test",
  issuedAt: new Date(NOW).toISOString(),
};
function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    data,
  };
}
const receiptStore = (disk, owner = "owner", machine = "crichton.local") =>
  ownerAdminReplayStore(disk, owner, machine);
const execute = (value, apply, store, now = NOW) =>
  executeOwnerAdminCommand(value, apply, "crichton.local", store, now);

test("a recent replay after simulated restart is refused before create is reapplied", async () => {
  const disk = storage();
  let calls = 0;
  const apply = async () => {
    calls++;
    return null;
  };
  assert.equal((await execute(command, apply, receiptStore(disk))).ok, true);
  const restarted = receiptStore(disk); // no in-memory receipts carried over
  const replay = await execute(command, apply, restarted, NOW + 1000);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "conflict");
  assert.equal(calls, 1);
});

test("more than 500 commands cannot evict a still-fresh replay receipt", async () => {
  const disk = storage();
  const store = receiptStore(disk);
  let calls = 0;
  const apply = async () => {
    calls++;
    return null;
  };
  for (let index = 0; index < 502; index++) {
    assert.equal(
      (await execute({ ...command, requestId: String(index) }, apply, store))
        .ok,
      true,
    );
  }
  assert.equal(
    (await execute({ ...command, requestId: "0" }, apply, receiptStore(disk)))
      .ok,
    false,
  );
  assert.equal(calls, 502);
});

test("replay receipt is persisted before save and a concurrent delivery cannot apply", async () => {
  const disk = storage();
  let release;
  const saving = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const apply = async () => {
    calls++;
    if (calls === 1) await saving;
    return null;
  };
  const first = execute(command, apply, receiptStore(disk));
  try {
    assert.equal(
      (await execute(command, apply, receiptStore(disk))).code,
      "conflict",
    );
    assert.equal(calls, 1);
  } finally {
    release();
    await first;
  }
});

test("unavailable or corrupt replay storage fails closed before any save", async () => {
  for (const disk of [
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    },
    { getItem: () => "bad-json", setItem() {} },
    { getItem: () => '[ ["id", null] ]', setItem() {} },
  ]) {
    let calls = 0;
    const ack = await execute(
      command,
      async () => {
        calls++;
        return null;
      },
      receiptStore(disk),
    );
    assert.equal(ack.ok, false);
    assert.equal(ack.code, "failed");
    assert.equal(calls, 0);
  }
});

test("receipts retain the freshness boundary then expire safely; owners and machines are isolated", () => {
  const disk = storage();
  const store = receiptStore(disk);
  assert.equal(store.claim("id", NOW + 300_000, NOW), true);
  assert.equal(store.claim("id", NOW + 300_000, NOW + 300_000), false);
  assert.equal(
    receiptStore(disk, "other-owner").claim("id", NOW + 300_000, NOW),
    true,
  );
  assert.equal(
    receiptStore(disk, "owner", "other-machine").claim(
      "id",
      NOW + 300_000,
      NOW,
    ),
    true,
  );
  assert.equal(store.claim("next", NOW + 600_000, NOW + 300_001), true);
  const original = JSON.parse([...disk.data.values()][0]);
  assert.deepEqual(original, [["next", NOW + 600_000]]);
});

test("a full receipt store rejects new writes without forgetting any live ids", () => {
  const disk = storage();
  const store = receiptStore(disk);
  const entries = Array.from({ length: 4096 }, (_, index) => [
    String(index),
    NOW + 300_000,
  ]);
  store.claim("initial", NOW + 300_000, NOW);
  const key = [...disk.data.keys()][0];
  disk.setItem(key, JSON.stringify(entries));
  assert.throws(() => store.claim("new", NOW + 300_000, NOW), /full/);
  assert.equal(receiptStore(disk).claim("0", NOW + 300_000, NOW), false);
  assert.equal(JSON.parse(disk.getItem(key)).length, 4096);
});

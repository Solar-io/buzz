import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_JOIN_ALERT_LEDGER,
  JOIN_ALERT_DEPARTED_MAX,
  foldRosterIntoLedger,
  joinAlertStorageKey,
  readJoinAlertLedger,
  writeJoinAlertLedger,
} from "./joinAlerts.ts";

function memoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    raw: store,
  };
}

test("the seeding fold announces nobody", () => {
  const fold = foldRosterIntoLedger(EMPTY_JOIN_ALERT_LEDGER, ["a", "b"], "me");
  assert.deepEqual(fold.joined, []);
  assert.equal(fold.ledger.seeded, true);
  assert.deepEqual(fold.ledger.pubkeys, ["a", "b"]);
});

test("a later fold announces only genuinely new pubkeys", () => {
  const seeded = foldRosterIntoLedger(
    EMPTY_JOIN_ALERT_LEDGER,
    ["a", "b"],
    "me",
  ).ledger;
  const fold = foldRosterIntoLedger(seeded, ["a", "b", "c"], "me");
  assert.deepEqual(fold.joined, ["c"]);
  // Re-receiving the same roster (reconnect, reconciler republish) is silent.
  const again = foldRosterIntoLedger(fold.ledger, ["a", "b", "c"], "me");
  assert.deepEqual(again.joined, []);
});

test("a viewer alone in the community still seeds, so the first join alerts", () => {
  // The seeding fold sees only the viewer and records an EMPTY pubkey list.
  // Inferring "seeded" from a non-empty list would classify the next fold as
  // the seeding one and swallow the first real join.
  const seeded = foldRosterIntoLedger(
    EMPTY_JOIN_ALERT_LEDGER,
    ["me"],
    "me",
  ).ledger;
  assert.deepEqual(seeded.pubkeys, []);
  assert.equal(seeded.seeded, true);

  const fold = foldRosterIntoLedger(seeded, ["me", "newcomer"], "me");
  assert.deepEqual(fold.joined, ["newcomer"]);
});

test("the viewer is never announced as new to themselves", () => {
  const seeded = foldRosterIntoLedger(EMPTY_JOIN_ALERT_LEDGER, [], "me").ledger;
  const fold = foldRosterIntoLedger(seeded, ["ME"], "me");
  assert.deepEqual(fold.joined, []);
});

test("someone who leaves and returns is announced again", () => {
  // Not an oversight: the ledger holds departed keys only up to the cap, and a
  // return genuinely is a new arrival to announce.
  const seeded = foldRosterIntoLedger(
    EMPTY_JOIN_ALERT_LEDGER,
    ["a"],
    "me",
  ).ledger;
  const left = foldRosterIntoLedger(seeded, [], "me");
  assert.deepEqual(left.joined, []);
  const back = foldRosterIntoLedger(left.ledger, ["a"], "me");
  assert.deepEqual(back.joined, [], "still remembered under the cap");
});

test("the cap sheds departed keys and never a key still on the roster", () => {
  const departed = Array.from(
    { length: JOIN_ALERT_DEPARTED_MAX + 10 },
    (_, index) => `gone-${index}`,
  );
  const seeded = foldRosterIntoLedger(
    EMPTY_JOIN_ALERT_LEDGER,
    departed,
    "me",
  ).ledger;
  const fold = foldRosterIntoLedger(seeded, ["stayer"], "me");

  assert.ok(fold.ledger.pubkeys.includes("stayer"));
  assert.equal(
    fold.ledger.pubkeys.length,
    JOIN_ALERT_DEPARTED_MAX + 1,
    "capped departed keys plus the live roster",
  );
  // The oldest departed keys are the ones shed.
  assert.equal(fold.ledger.pubkeys.includes("gone-0"), false);
  assert.equal(
    fold.ledger.pubkeys.includes(`gone-${JOIN_ALERT_DEPARTED_MAX + 9}`),
    true,
  );
});

test("a roster larger than the cap keeps every live member", () => {
  const roster = Array.from(
    { length: JOIN_ALERT_DEPARTED_MAX + 500 },
    (_, index) => `live-${index}`,
  );
  const fold = foldRosterIntoLedger(EMPTY_JOIN_ALERT_LEDGER, roster, "me");
  assert.equal(fold.ledger.pubkeys.length, roster.length);
});

test("the ledger round-trips through storage", () => {
  const storage = memoryStorage();
  const key = joinAlertStorageKey("WSS://Relay.Example", "ABC");
  assert.equal(key, "buzz:community-join-seen.v1:wss://relay.example:abc");

  writeJoinAlertLedger(storage, key, { seeded: true, pubkeys: ["a"] });
  assert.deepEqual(readJoinAlertLedger(storage, key), {
    seeded: true,
    pubkeys: ["a"],
  });
});

test("a corrupt or hostile stored ledger degrades to the empty one", () => {
  const storage = memoryStorage({
    bad: "{not json",
    scalar: "42",
    wrong: JSON.stringify({ seeded: true, pubkeys: "nope" }),
    mixed: JSON.stringify({ seeded: true, pubkeys: ["ok", 7, null] }),
  });
  assert.deepEqual(
    readJoinAlertLedger(storage, "bad"),
    EMPTY_JOIN_ALERT_LEDGER,
  );
  assert.deepEqual(
    readJoinAlertLedger(storage, "scalar"),
    EMPTY_JOIN_ALERT_LEDGER,
  );
  assert.deepEqual(
    readJoinAlertLedger(storage, "wrong"),
    EMPTY_JOIN_ALERT_LEDGER,
  );
  assert.deepEqual(readJoinAlertLedger(storage, "mixed"), {
    seeded: true,
    pubkeys: ["ok"],
  });
  assert.deepEqual(readJoinAlertLedger(null, "bad"), EMPTY_JOIN_ALERT_LEDGER);
});

test("a storage that throws never breaks a fold", () => {
  const hostile = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
  };
  assert.deepEqual(readJoinAlertLedger(hostile, "k"), EMPTY_JOIN_ALERT_LEDGER);
  assert.doesNotThrow(() =>
    writeJoinAlertLedger(hostile, "k", EMPTY_JOIN_ALERT_LEDGER),
  );
});

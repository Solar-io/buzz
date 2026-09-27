import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveHiddenDms,
  hiddenDmSnapshotFilter,
  hideDm,
  hideDmEventTemplate,
  isHiddenDmMigrationDone,
  loadHiddenDms,
  markHiddenDmMigrationDone,
  migrationCandidates,
  newerSnapshot,
  parseHiddenSnapshot,
  saveHiddenDms,
  unhideDm,
} from "./hiddenDms.ts";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.get(k) ?? null;
  }
  setItem(k, v) {
    this.map.set(k, v);
  }
}

test("hideDm appends once (no duplicates)", () => {
  assert.deepEqual(hideDm([], "a"), ["a"]);
  assert.deepEqual(hideDm(["a"], "a"), ["a"]);
});

test("unhideDm removes only the target", () => {
  assert.deepEqual(unhideDm(["a", "b"], "a"), ["b"]);
  assert.deepEqual(unhideDm(["a"], "zzz"), ["a"]);
});

test("save→load round-trips and dedupes", () => {
  const storage = new MemoryStorage();
  saveHiddenDms(storage, ["a", "a", "b"]);
  assert.deepEqual(loadHiddenDms(storage), ["a", "b"]);
});

test("load tolerates null storage, missing, and corrupt data", () => {
  assert.deepEqual(loadHiddenDms(null), []);
  const storage = new MemoryStorage();
  assert.deepEqual(loadHiddenDms(storage), []);
  storage.setItem("buzz:dm-hidden", "{not json");
  assert.deepEqual(loadHiddenDms(storage), []);
  storage.setItem("buzz:dm-hidden", JSON.stringify({ nope: true }));
  assert.deepEqual(loadHiddenDms(storage), []);
});

// --- Relay-synced hiding (NIP-DV) ---------------------------------------

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const snap = (tags, created_at = 100, id = "e1") => ({
  id,
  kind: 30622,
  created_at,
  tags,
});

test("snapshot filter queries own 30622 by #p (the relay read gate)", () => {
  assert.deepEqual(hiddenDmSnapshotFilter(ME), {
    kinds: [30622],
    "#p": [ME],
    limit: 1,
  });
});

test("parseHiddenSnapshot collects h tags as a set for self", () => {
  const parsed = parseHiddenSnapshot(
    snap([
      ["d", ME],
      ["p", ME],
      ["h", "x"],
      ["h", "y"],
      ["h", "x"],
    ]),
    ME,
  );
  assert.deepEqual(parsed, { id: "e1", createdAt: 100, ids: ["x", "y"] });
});

test("parseHiddenSnapshot rejects another viewer's or wrong-kind events", () => {
  const h = ["h", "x"];
  assert.equal(
    parseHiddenSnapshot(snap([["d", OTHER], ["p", OTHER], h]), ME),
    null,
  );
  assert.equal(
    parseHiddenSnapshot(snap([["d", ME], ["p", OTHER], h]), ME),
    null,
  );
  assert.equal(parseHiddenSnapshot(snap([["p", ME], h]), ME), null);
  const wrongKind = { ...snap([["d", ME], ["p", ME], h]), kind: 30623 };
  assert.equal(parseHiddenSnapshot(wrongKind, ME), null);
});

test("empty snapshot means nothing hidden (not 'no snapshot')", () => {
  const parsed = parseHiddenSnapshot(
    snap([
      ["d", ME],
      ["p", ME],
    ]),
    ME,
  );
  assert.deepEqual(effectiveHiddenDms(parsed, ["stale"], new Map()).hidden, []);
});

test("newerSnapshot keeps the latest created_at, ties to lowest id", () => {
  const a = { id: "b", createdAt: 10, ids: ["old"] };
  const b = { id: "c", createdAt: 20, ids: ["new"] };
  assert.equal(newerSnapshot(a, b), b);
  assert.equal(newerSnapshot(b, a), b);
  assert.equal(newerSnapshot(null, a), a);
  const tie = { id: "a", createdAt: 10, ids: [] };
  assert.equal(newerSnapshot(a, tie), tie);
});

test("cache is used only until a snapshot arrives; snapshot wins", () => {
  assert.deepEqual(effectiveHiddenDms(null, ["c1"], new Map()).hidden, ["c1"]);
  const s = { id: "e", createdAt: 50, ids: ["s1"] };
  assert.deepEqual(effectiveHiddenDms(s, ["c1"], new Map()).hidden, ["s1"]);
});

test("optimistic hide applies until a newer snapshot supersedes it", () => {
  const pending = new Map([["d1", { hidden: true, at: 100 }]]);
  const stale = { id: "e", createdAt: 90, ids: [] };
  const r1 = effectiveHiddenDms(stale, [], pending);
  assert.deepEqual(r1.hidden, ["d1"]);
  assert.equal(r1.pending.size, 1);
  // A later snapshot (e.g. another device unhid it) wins over the local hide.
  const fresh = { id: "f", createdAt: 100, ids: [] };
  const r2 = effectiveHiddenDms(fresh, [], pending);
  assert.deepEqual(r2.hidden, []);
  assert.equal(r2.pending.size, 0);
});

test("re-open (unhide) is not kept hidden by the cache or an old snapshot", () => {
  const pending = new Map([["d1", { hidden: false, at: 200 }]]);
  const old = { id: "e", createdAt: 150, ids: ["d1", "d2"] };
  assert.deepEqual(effectiveHiddenDms(old, [], pending).hidden, ["d2"]);
  assert.deepEqual(effectiveHiddenDms(null, ["d1"], pending).hidden, []);
});

test("migrationCandidates = local ids missing from the relay snapshot", () => {
  const s = { id: "e", createdAt: 1, ids: ["a"] };
  assert.deepEqual(migrationCandidates(["a", "b", "b", "c"], s), ["b", "c"]);
  assert.deepEqual(migrationCandidates(["a", "b"], null), ["a", "b"]);
});

test("hide event is kind 41012 with one h tag", () => {
  assert.deepEqual(hideDmEventTemplate("chan"), {
    kind: 41012,
    tags: [["h", "chan"]],
    content: "",
  });
});

test("migration marker is per pubkey", () => {
  const storage = new MemoryStorage();
  assert.equal(isHiddenDmMigrationDone(storage, ME), false);
  markHiddenDmMigrationDone(storage, ME);
  assert.equal(isHiddenDmMigrationDone(storage, ME), true);
  assert.equal(isHiddenDmMigrationDone(storage, OTHER), false);
});

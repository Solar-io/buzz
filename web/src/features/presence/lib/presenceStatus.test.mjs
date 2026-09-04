import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_IDLE_TIMEOUT_MS,
  PRESENCE_TTL_SECONDS,
  effectivePresenceStatus,
  mergePresenceEntry,
  parsePresenceContent,
  preferenceForManualPick,
  presenceChipClass,
  presenceDotClass,
  presenceEntryFromEvent,
  presenceLabel,
  presencePreferenceStorageKey,
  readPresencePreference,
  resolveAutomaticPresenceStatus,
  writePresencePreference,
} from "./presenceStatus.ts";

function memoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    size: () => store.size,
    raw: store,
  };
}

test("the heartbeat is strictly faster than the relay TTL", () => {
  // The relay expires presence after PRESENCE_TTL_SECONDS. A heartbeat at or
  // slower than the TTL would let every client flicker offline between beats.
  // Hardcoded on both sides: deriving one from the other would make this
  // assertion pin itself instead of the relationship.
  assert.equal(PRESENCE_HEARTBEAT_INTERVAL_MS, 60_000);
  assert.equal(PRESENCE_TTL_SECONDS, 180);
  assert.ok(PRESENCE_HEARTBEAT_INTERVAL_MS / 1000 < PRESENCE_TTL_SECONDS);
});

test("parsePresenceContent accepts the bare-string wire shape", () => {
  assert.equal(parsePresenceContent("online"), "online");
  assert.equal(parsePresenceContent(" away "), "away");
  assert.equal(parsePresenceContent("offline"), "offline");
});

test("parsePresenceContent accepts the legacy JSON wire shape", () => {
  assert.equal(parsePresenceContent('{"status":"online"}'), "online");
  assert.equal(parsePresenceContent('{"status":" away "}'), "away");
});

test("parsePresenceContent rejects junk rather than guessing", () => {
  assert.equal(parsePresenceContent(""), "unknown");
  assert.equal(parsePresenceContent("busy"), "unknown");
  assert.equal(parsePresenceContent("{not json"), "unknown");
  assert.equal(parsePresenceContent('{"status":42}'), "unknown");
});

test("presenceEntryFromEvent ignores non-presence kinds", () => {
  assert.equal(
    presenceEntryFromEvent({
      kind: 9,
      pubkey: "aa",
      content: "online",
      created_at: 1,
    }),
    null,
  );
});

test("presenceEntryFromEvent takes the AUTHOR as the subject", () => {
  // A forged `p` tag must never be able to set someone else's status. The
  // parser does not read tags at all, so the author is structurally the only
  // possible subject; this pins that the author survives to the entry.
  const entry = presenceEntryFromEvent({
    kind: 20001,
    pubkey: "AABB",
    content: "away",
    created_at: 17,
  });
  assert.deepEqual(entry, { pubkey: "aabb", status: "away", updatedAt: 17 });
});

test("mergePresenceEntry keeps the newest event per author", () => {
  const first = new Map();
  const second = mergePresenceEntry(first, {
    pubkey: "a",
    status: "online",
    updatedAt: 10,
  });
  const older = mergePresenceEntry(second, {
    pubkey: "a",
    status: "offline",
    updatedAt: 9,
  });
  assert.equal(older, second, "an older event must not replace the map");
  assert.equal(older.get("a").status, "online");

  const newer = mergePresenceEntry(second, {
    pubkey: "a",
    status: "offline",
    updatedAt: 11,
  });
  assert.notEqual(newer, second);
  assert.equal(newer.get("a").status, "offline");
});

test("resolveAutomaticPresenceStatus flips to away at the idle threshold", () => {
  const now = 1_000_000_000;
  assert.equal(resolveAutomaticPresenceStatus(now, now), "online");
  assert.equal(
    resolveAutomaticPresenceStatus(now - (PRESENCE_IDLE_TIMEOUT_MS - 1), now),
    "online",
  );
  assert.equal(
    resolveAutomaticPresenceStatus(now - PRESENCE_IDLE_TIMEOUT_MS, now),
    "away",
  );
  // A future activity stamp (clock skew) must read online, not away.
  assert.equal(resolveAutomaticPresenceStatus(now + 5_000, now), "online");
});

test("effectivePresenceStatus lets a manual choice override the clock", () => {
  // Discriminating fixture: the automatic status is "away" while the
  // preference says online-auto, and "online" while the preference pins away.
  assert.equal(effectivePresenceStatus("auto", "away"), "away");
  assert.equal(effectivePresenceStatus("auto", "online"), "online");
  assert.equal(effectivePresenceStatus("away", "online"), "away");
  assert.equal(effectivePresenceStatus("offline", "online"), "offline");
  assert.equal(effectivePresenceStatus("offline", "away"), "offline");
});

test("picking Active returns to the clock instead of pinning online", () => {
  assert.equal(preferenceForManualPick("online"), "auto");
  assert.equal(preferenceForManualPick("away"), "away");
  assert.equal(preferenceForManualPick("offline"), "offline");
});

test("presence preferences are stored per pubkey", () => {
  const storage = memoryStorage();
  writePresencePreference(storage, "AAA", "offline");
  assert.equal(readPresencePreference(storage, "aaa"), "offline");
  // A different identity in the same browser is unaffected.
  assert.equal(readPresencePreference(storage, "bbb"), "auto");
  assert.equal(
    presencePreferenceStorageKey("AAA"),
    "buzz:presence-preference:aaa",
  );
});

test("writing `auto` clears the stored preference rather than storing it", () => {
  const storage = memoryStorage();
  writePresencePreference(storage, "aaa", "away");
  assert.equal(storage.size(), 1);
  writePresencePreference(storage, "aaa", "auto");
  assert.equal(storage.size(), 0);
  assert.equal(readPresencePreference(storage, "aaa"), "auto");
});

test("preference reads survive a storage that throws", () => {
  const hostile = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("SecurityError");
    },
    removeItem() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readPresencePreference(hostile, "aaa"), "auto");
  assert.doesNotThrow(() => writePresencePreference(hostile, "aaa", "away"));
  assert.equal(readPresencePreference(null, "aaa"), "auto");
});

test("labels and classes discriminate every status", () => {
  const statuses = ["online", "away", "offline", "unknown"];
  const labels = new Set(statuses.map(presenceLabel));
  assert.equal(labels.size, 4, "each status needs its own label");
  assert.notEqual(presenceDotClass("online"), presenceDotClass("away"));
  assert.notEqual(presenceDotClass("away"), presenceDotClass("offline"));
  assert.notEqual(presenceChipClass("online"), presenceChipClass("away"));
});

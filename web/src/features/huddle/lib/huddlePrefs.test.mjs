import assert from "node:assert/strict";
import { test } from "node:test";

const {
  DEFAULT_HUDDLE_PREFS,
  clearHuddlePrefs,
  huddlePrefsKey,
  loadHuddlePrefs,
  resolveHuddleVoice,
  saveHuddlePrefs,
} = await import("./huddlePrefs.ts");

/** A minimal in-memory Storage, plus a variant that throws on every call. */
function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}
const throwingStore = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

const PARENT = "parent-channel-1";

test("prefs are keyed by the PARENT channel id", () => {
  assert.equal(huddlePrefsKey(PARENT), "buzz.huddle.prefs.parent-channel-1");
  assert.notEqual(huddlePrefsKey("a"), huddlePrefsKey("b"));
});

test("an unset channel loads the shipped defaults: no override, half-duplex", () => {
  const prefs = loadHuddlePrefs(memoryStore(), PARENT);
  assert.equal(prefs.voice, null);
  assert.equal(prefs.duplex, "half");
  assert.deepEqual(prefs, DEFAULT_HUDDLE_PREFS);
});

test("a saved override round-trips through the store", () => {
  const store = memoryStore();
  saveHuddlePrefs(store, PARENT, {
    voice: { engine: "eleven", key: "eleven:abc123" },
    duplex: "barge",
  });
  const loaded = loadHuddlePrefs(store, PARENT);
  assert.deepEqual(loaded.voice, { engine: "eleven", key: "eleven:abc123" });
  assert.equal(loaded.duplex, "barge");
  // ...and it lives under this channel's key alone.
  assert.equal(store.map.size, 1);
  assert.deepEqual(loadHuddlePrefs(store, "other-channel"), {
    voice: null,
    duplex: "half",
  });
});

test("clearing a channel restores the defaults", () => {
  const store = memoryStore();
  saveHuddlePrefs(store, PARENT, {
    voice: { engine: "pocket", key: "pocket:anna" },
    duplex: "barge",
  });
  clearHuddlePrefs(store, PARENT);
  assert.deepEqual(loadHuddlePrefs(store, PARENT), DEFAULT_HUDDLE_PREFS);
});

test("malformed, hostile and unreadable stores all read as the defaults", () => {
  const cases = [
    "not json at all",
    "null",
    '"a string"',
    '{"voice":{"engine":"local-synth","voiceURI":"uri:x"},"duplex":"half"}',
    '{"voice":{"engine":"pocket"},"duplex":"nonsense"}',
    '{"voice":42,"duplex":7}',
  ];
  for (const raw of cases) {
    const prefs = loadHuddlePrefs(
      memoryStore({ [huddlePrefsKey(PARENT)]: raw }),
      PARENT,
    );
    assert.equal(prefs.voice, null, `voice for ${raw}`);
    assert.equal(prefs.duplex, "half", `duplex for ${raw}`);
  }
  // A store that throws (private mode, blocked site data) must not throw
  // out of a render — read AND write.
  assert.deepEqual(loadHuddlePrefs(throwingStore, PARENT), DEFAULT_HUDDLE_PREFS);
  assert.doesNotThrow(() =>
    saveHuddlePrefs(throwingStore, PARENT, DEFAULT_HUDDLE_PREFS),
  );
  assert.doesNotThrow(() => clearHuddlePrefs(throwingStore, PARENT));
  // No store at all (SSR / no window) is the same answer.
  assert.deepEqual(loadHuddlePrefs(null, PARENT), DEFAULT_HUDDLE_PREFS);
});

test("resolution order: the channel override outranks the published selection", () => {
  const published = { engine: "pocket", key: "pocket:vera" };
  const resolved = resolveHuddleVoice(
    { engine: "eleven", key: "eleven:zz" },
    published,
  );
  // Discriminating on BOTH fields: a resolver that returned the published
  // row would answer pocket/pocket:vera here.
  assert.deepEqual(resolved, { engine: "eleven", key: "eleven:zz" });
});

test("resolution order: with no override the published selection speaks", () => {
  assert.deepEqual(resolveHuddleVoice(null, { engine: "pocket", key: "pocket:vera" }), {
    engine: "pocket",
    key: "pocket:vera",
  });
  assert.deepEqual(
    resolveHuddleVoice(undefined, { engine: "eleven", key: "eleven:q" }),
    { engine: "eleven", key: "eleven:q" },
  );
});

test("resolution order: nothing chosen resolves to undefined (the derived default)", () => {
  assert.equal(resolveHuddleVoice(null, undefined), undefined);
  assert.equal(resolveHuddleVoice(undefined, undefined), undefined);
});

test("a published local-synth selection resolves like NO selection", () => {
  // The dropped engine: the row still decodes, but it no longer decides —
  // an old on-device selection must not drag the OS robot back into a call.
  assert.equal(
    resolveHuddleVoice(null, { engine: "local-synth", voiceURI: "uri:samantha" }),
    undefined,
  );
  // ...and an explicit channel override still wins over it.
  assert.deepEqual(
    resolveHuddleVoice(
      { engine: "pocket", key: "pocket:mary" },
      { engine: "local-synth", voiceURI: "uri:samantha" },
    ),
    { engine: "pocket", key: "pocket:mary" },
  );
});

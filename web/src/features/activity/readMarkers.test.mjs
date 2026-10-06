import assert from "node:assert/strict";
import { test } from "node:test";

// The read-marker store (phase 2): one copy, every write through it.

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
const listeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  },
  removeEventListener() {},
};
globalThis.localStorage = fakeStorage();

const {
  forgetMarker,
  getChannelMarkers,
  markSeen,
  onLocalChange,
  resetReadMarkersForTests,
  subscribeReadMarkers,
} = await import("./readMarkers.ts");
const { clearUnreadTrace, readUnreadTrace } = await import("./unreadTrace.ts");
const { channelMenuItems } = await import("../sidebar/lib/channelMenuItems.ts");

function fresh(seed = {}) {
  globalThis.localStorage = fakeStorage();
  globalThis.localStorage.setItem("buzz.read-state.v1", JSON.stringify(seed));
  listeners.clear();
  resetReadMarkersForTests();
  clearUnreadTrace();
}

test("markSeen persists, notifies readers, arms the NIP-RS publish, and never moves backwards", () => {
  fresh({ c1: 100 });
  const changes = [];
  let publishes = 0;
  const off = subscribeReadMarkers((change) => changes.push(change));
  const offLocal = onLocalChange(() => {
    publishes += 1;
  });
  try {
    assert.equal(markSeen("c1", 50, "open"), false, "never backwards");
    assert.equal(markSeen("c1", 150, "open"), true);
    assert.equal(getChannelMarkers().c1, 150);
    assert.equal(
      JSON.parse(localStorage.getItem("buzz.read-state.v1")).c1,
      150,
      "persisted",
    );
    assert.deepEqual(changes, ["local"]);
    assert.equal(publishes, 1, "the NIP-RS publisher hears the local move");
    forgetMarker("c1");
    assert.equal(getChannelMarkers().c1, undefined);
    assert.deepEqual(
      readUnreadTrace().map((e) => [e.id, e.to, e.source]),
      [
        ["c1", 150, "open"],
        ["c1", null, "evict"],
      ],
    );
  } finally {
    off();
    offLocal();
  }
});

test("another tab's write is max-merged in and traced as 'storage' (never lowers a marker)", () => {
  fresh({ a: 100, b: 500 });
  getChannelMarkers(); // load + start listening
  const changes = [];
  const off = subscribeReadMarkers((change) => changes.push(change));
  try {
    globalThis.localStorage.setItem(
      "buzz.read-state.v1",
      JSON.stringify({ a: 300, b: 200 }),
    );
    for (const fn of listeners.get("storage") ?? []) {
      fn({ key: "buzz.read-state.v1" });
    }
    assert.deepEqual(getChannelMarkers(), { a: 300, b: 500 });
    assert.deepEqual(changes, ["storage"]);
    assert.deepEqual(
      readUnreadTrace().map((e) => [e.id, e.from, e.to, e.source]),
      [["a", 100, 300, "storage"]],
    );
  } finally {
    off();
  }
});

test("'Mark read' marks up to the newest message, not the channel's metadata time (which new messages never bump)", () => {
  fresh({});
  const channel = { id: "ch-x", name: "x", updatedAt: 1_000 };
  const items = channelMenuItems(channel, {
    session: {},
    channelPrefs: { favorites: [], muted: [] },
    setChannelPrefs: () => {},
    newestActivityAt: (id) => (id === "ch-x" ? 5_000 : undefined),
    refreshChannels: () => {},
    onChannelDeleted: () => {},
    selectedId: undefined,
    onCloseChannel: () => {},
  });
  items.find((item) => item.label === "Mark read").onSelect();
  assert.equal(getChannelMarkers()["ch-x"], 5_000);
  assert.equal(readUnreadTrace().at(-1).source, "menu");
});

test("QA #19: a DM row's menu has Mark read — it marks up to the newest message, traces 'menu' and arms the NIP-RS publish", async () => {
  fresh({ "dm-1": 100 });
  const { dmMenuItems } = await import("../sidebar/lib/dmMenuItems.ts");
  let published = 0;
  const off = onLocalChange(() => {
    published += 1;
  });
  try {
    const dm = {
      channel: { id: "dm-1", updatedAt: 50 },
      lastActivity: 400,
      lastMessage: { created_at: 400 },
    };
    const items = dmMenuItems(dm, {
      favorite: false,
      newestActivityAt: 450,
      onToggleFavorite: () => {},
      onHide: () => {},
    });
    assert.deepEqual(
      items.map((item) => item.label),
      ["Add to Favorites", "Mark read", "Remove from list"],
    );
    items.find((item) => item.label === "Mark read").onSelect();
    assert.equal(getChannelMarkers()["dm-1"], 450);
    assert.equal(readUnreadTrace().at(-1).source, "menu");
    assert.equal(published, 1, "synced to the other devices");
  } finally {
    off();
  }
});

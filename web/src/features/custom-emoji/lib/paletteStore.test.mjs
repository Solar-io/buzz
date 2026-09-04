import assert from "node:assert/strict";
import test from "node:test";

import {
  createPaletteStore,
  mergeEmojiSetEvent,
  paletteFromEvents,
} from "./paletteStore.ts";

const event = (pubkey, createdAt, entries) => ({
  pubkey,
  created_at: createdAt,
  tags: entries.map(([shortcode, url]) => ["emoji", shortcode, url]),
});

test("a newer set from the same author replaces the older one", () => {
  let events = new Map();
  events = mergeEmojiSetEvent(
    events,
    event("alice", 100, [["a", "https://x/a.png"]]),
  );
  events = mergeEmojiSetEvent(
    events,
    event("alice", 200, [["b", "https://x/b.png"]]),
  );
  assert.equal(events.size, 1, "one event per author");
  assert.deepEqual(paletteFromEvents(events), [
    { shortcode: "b", url: "https://x/b.png" },
  ]);
});

/**
 * The reason the store holds events per author instead of accumulating them:
 * removing an emoji is a republished set that no longer lists it, and a naive
 * accumulator would keep showing the removed emoji from the older event.
 */
test("an emoji removed from a member's set disappears from the palette", () => {
  let events = new Map();
  events = mergeEmojiSetEvent(
    events,
    event("alice", 100, [
      ["keep", "https://x/k.png"],
      ["drop", "https://x/d.png"],
    ]),
  );
  events = mergeEmojiSetEvent(
    events,
    event("alice", 101, [["keep", "https://x/k.png"]]),
  );
  assert.deepEqual(paletteFromEvents(events), [
    { shortcode: "keep", url: "https://x/k.png" },
  ]);
});

test("an older or replayed event changes nothing and returns the same map", () => {
  const first = event("alice", 200, [["a", "https://x/a.png"]]);
  const events = mergeEmojiSetEvent(new Map(), first);
  assert.equal(mergeEmojiSetEvent(events, first), events, "replay");
  assert.equal(
    mergeEmojiSetEvent(events, event("alice", 100, [["b", "https://x/b.png"]])),
    events,
    "older",
  );
});

test("different authors both contribute", () => {
  let events = new Map();
  events = mergeEmojiSetEvent(
    events,
    event("alice", 100, [["a", "https://x/a.png"]]),
  );
  events = mergeEmojiSetEvent(
    events,
    event("bob", 100, [["b", "https://x/b.png"]]),
  );
  assert.equal(events.size, 2);
  assert.deepEqual(
    paletteFromEvents(events).map((entry) => entry.shortcode),
    ["a", "b"],
  );
});

/** A relay stand-in that hands back its own `onEvent` so a test can push. */
function fakeSource() {
  const state = { filter: null, emit: null, closed: 0, opened: 0 };
  return {
    state,
    source: {
      subscribe(filter, handlers) {
        state.filter = filter;
        state.emit = handlers.onEvent;
        state.opened += 1;
        return () => {
          state.closed += 1;
        };
      },
    },
  };
}

test("the store opens one subscription and fans events out to listeners", () => {
  const { state, source } = fakeSource();
  const store = createPaletteStore({ kinds: [30030] });

  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  store.subscribe(() => {
    notified += 1;
  });

  assert.deepEqual(store.getSnapshot(), []);
  store.attach(source);
  store.attach(source);
  assert.equal(state.opened, 1, "attaching the same source twice opens once");
  assert.deepEqual(state.filter, { kinds: [30030] });

  state.emit(event("alice", 100, [["a", "https://x/a.png"]]));
  assert.equal(notified, 2, "both listeners fired");
  assert.deepEqual(store.getSnapshot(), [
    { shortcode: "a", url: "https://x/a.png" },
  ]);
});

test("the snapshot keeps its reference when an event changes nothing", () => {
  const { state, source } = fakeSource();
  const store = createPaletteStore({});
  store.attach(source);
  const first = event("alice", 100, [["a", "https://x/a.png"]]);
  state.emit(first);
  const snapshot = store.getSnapshot();
  state.emit(first);
  assert.equal(
    store.getSnapshot(),
    snapshot,
    "a replay must not produce a new array — useSyncExternalStore would loop",
  );
});

test("attaching a different source drops the old palette and resubscribes", () => {
  const first = fakeSource();
  const second = fakeSource();
  const store = createPaletteStore({});
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });

  store.attach(first.source);
  first.state.emit(event("alice", 100, [["a", "https://x/a.png"]]));
  assert.equal(store.getSnapshot().length, 1);

  store.attach(second.source);
  assert.equal(first.state.closed, 1, "the old subscription is closed");
  assert.equal(second.state.opened, 1);
  assert.deepEqual(store.getSnapshot(), [], "the palette is cleared");
  assert.ok(notified >= 2, "the drop is announced");

  // Clearing the SNAPSHOT is not enough, and asserting only on it does not
  // discriminate: if the accumulated events survive the switch, the first
  // event from the new community re-unions the old ones back in.
  second.state.emit(event("carol", 100, [["b", "https://y/b.png"]]));
  assert.deepEqual(store.getSnapshot(), [
    { shortcode: "b", url: "https://y/b.png" },
  ]);
});

test("an unsubscribed listener stops being called", () => {
  const { state, source } = fakeSource();
  const store = createPaletteStore({});
  let notified = 0;
  const off = store.subscribe(() => {
    notified += 1;
  });
  store.attach(source);
  state.emit(event("alice", 100, [["a", "https://x/a.png"]]));
  off();
  state.emit(event("bob", 100, [["b", "https://x/b.png"]]));
  assert.equal(notified, 1);
});

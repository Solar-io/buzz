import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_ACTIVITY_PREVIEW_MAX,
  MAX_FILTERS_PER_REQ,
  UNREAD_COUNT_BUFFER_MAX,
  UNREAD_COUNT_CAP,
  UNREAD_COUNT_SAMPLE_LIMIT,
  applyChannelActivity,
  channelActivityFilterBatches,
  channelActivityFromEvent,
  channelUnreadSignal,
  countUnreadFromEvents,
  createChannelActivityHandlers,
  formatUnreadCount,
  incrementUnreadCount,
  isChannelRowUnread,
  resetCountsForMarkerChanges,
} from "./channelActivity.ts";

const SELF = "selfpubkey";
const OTHER = "otherpubkey";

function entry(overrides = {}) {
  return {
    channelId: overrides.channelId ?? "ch1",
    createdAt: overrides.createdAt ?? 100,
    pubkey: overrides.pubkey ?? OTHER,
    preview: overrides.preview ?? "hello",
  };
}

function relayEvent(overrides = {}) {
  return {
    id: overrides.id ?? "e1",
    pubkey: overrides.pubkey ?? OTHER,
    created_at: overrides.created_at ?? 100,
    content: overrides.content ?? "hello world",
    tags: overrides.tags ?? [["h", overrides.channelId ?? "ch1"]],
    kind: 9,
    sig: "s",
  };
}

test("applyChannelActivity is newest-wins and out-of-order arrivals change nothing", () => {
  const empty = new Map();
  const first = applyChannelActivity(empty, entry({ createdAt: 200 }));
  assert.equal(first.get("ch1").createdAt, 200);
  assert.equal(first.size, 1);

  // An older arrival must not replace the newer sample — same Map ref back.
  const stale = applyChannelActivity(first, entry({ createdAt: 150 }));
  assert.equal(stale, first);
  assert.equal(stale.get("ch1").createdAt, 200);

  // Equal timestamps are replays/duplicates, not updates.
  const replay = applyChannelActivity(first, entry({ createdAt: 200 }));
  assert.equal(replay, first);

  // A newer arrival replaces the entry with a new Map ref.
  const next = applyChannelActivity(first, entry({ createdAt: 250 }));
  assert.notEqual(next, first);
  assert.equal(next.get("ch1").createdAt, 250);
  assert.equal(next.size, 1);
});

test("applyChannelActivity keeps channels independent", () => {
  let map = applyChannelActivity(
    new Map(),
    entry({ channelId: "a", createdAt: 10 }),
  );
  map = applyChannelActivity(map, entry({ channelId: "b", createdAt: 5 }));
  assert.equal(map.size, 2);
  assert.equal(map.get("a").createdAt, 10);
  assert.equal(map.get("b").createdAt, 5);
});

test("channelActivityFromEvent reads the h tag, author and created_at", () => {
  const parsed = channelActivityFromEvent(
    relayEvent({ created_at: 123, pubkey: OTHER, channelId: "ch9" }),
  );
  assert.deepEqual(parsed, {
    channelId: "ch9",
    createdAt: 123,
    pubkey: OTHER,
    preview: "hello world",
    eventId: "e1",
  });
  // No h tag = not a channel message; the caller drops it.
  assert.equal(channelActivityFromEvent(relayEvent({ tags: [] })), null);
});

test("channelActivityFromEvent strips markdown noise and bounds the preview", () => {
  const parsed = channelActivityFromEvent(
    relayEvent({
      content:
        "# Heading **bold** ![pic](http://x/y.png) [link](http://z) \n\n  spaced   out ",
    }),
  );
  assert.equal(parsed.preview, "Heading bold 📷 image link spaced out");

  const long = channelActivityFromEvent(
    relayEvent({ content: "x".repeat(CHANNEL_ACTIVITY_PREVIEW_MAX + 100) }),
  );
  assert.equal(long.preview.length, CHANNEL_ACTIVITY_PREVIEW_MAX);
});

test("channelUnreadSignal: self activity falls back to metadata, others win", () => {
  const updatedAt = 50;
  // No sample yet -> the metadata timestamp is the signal.
  assert.equal(
    channelUnreadSignal({ activity: undefined, updatedAt, selfPubkey: SELF }),
    updatedAt,
  );
  // A self-authored newest message must not read as unread activity.
  assert.equal(
    channelUnreadSignal({
      activity: entry({ createdAt: 150, pubkey: SELF }),
      updatedAt,
      selfPubkey: SELF,
    }),
    updatedAt,
  );
  // Someone else's message IS the signal.
  assert.equal(
    channelUnreadSignal({
      activity: entry({ createdAt: 150, pubkey: OTHER }),
      updatedAt,
      selfPubkey: SELF,
    }),
    150,
  );
});

test("isChannelRowUnread compares the signal against the read marker", () => {
  const base = {
    read: { ch1: 100 },
    channelId: "ch1",
    updatedAt: 50,
    selfPubkey: SELF,
  };
  // Self message newer than the marker: stored, but never unread.
  assert.equal(
    isChannelRowUnread({
      ...base,
      activity: entry({ createdAt: 150, pubkey: SELF }),
    }),
    false,
  );
  // Other's message newer than the marker: unread.
  assert.equal(
    isChannelRowUnread({
      ...base,
      activity: entry({ createdAt: 150, pubkey: OTHER }),
    }),
    true,
  );
  // Other's message at the marker: read.
  assert.equal(
    isChannelRowUnread({
      ...base,
      activity: entry({ createdAt: 100, pubkey: OTHER }),
    }),
    false,
  );
  // No activity: pre-existing metadata behaviour (updatedAt vs marker).
  assert.equal(isChannelRowUnread({ ...base, activity: undefined }), false);
  assert.equal(
    isChannelRowUnread({ ...base, updatedAt: 120, activity: undefined }),
    true,
  );
  // A channel never read starts unread the moment anyone else posts.
  assert.equal(
    isChannelRowUnread({
      read: {},
      channelId: "ch2",
      updatedAt: 0,
      selfPubkey: SELF,
      activity: entry({ channelId: "ch2", createdAt: 1, pubkey: OTHER }),
    }),
    true,
  );
});

test("channelActivityFilterBatches packs per-channel filters 10 per REQ", () => {
  assert.equal(MAX_FILTERS_PER_REQ, 10);
  const ids = Array.from({ length: 23 }, (_, i) => `channel-${i}`);
  const batches = channelActivityFilterBatches(ids);
  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [10, 10, 3],
  );
  // Exact per-channel sampling: newest-only per channel, OR'd within a REQ.
  assert.deepEqual(batches[0][0], {
    kinds: [9],
    "#h": ["channel-0"],
    limit: 1,
  });
  assert.deepEqual(batches[2][2], {
    kinds: [9],
    "#h": ["channel-22"],
    limit: 1,
  });
  // No ids, no REQs.
  assert.deepEqual(channelActivityFilterBatches([]), []);
});

test("channelActivityFilterBatches counting mode scopes each filter to its read marker", () => {
  assert.equal(UNREAD_COUNT_SAMPLE_LIMIT, 200);
  assert.equal(UNREAD_COUNT_BUFFER_MAX, 250);
  const batches = channelActivityFilterBatches(["a", "b"], {
    a: 1000,
    c: 9999,
  });
  // Marker known: the window opens at the marker. Marker unknown: since 0
  // (the never-read case — limit 100: the badge caps at 99+ anyway).
  assert.deepEqual(batches[0][0], {
    kinds: [9],
    "#h": ["a"],
    since: 1000,
    limit: 200,
  });
  assert.deepEqual(batches[0][1], {
    kinds: [9],
    "#h": ["b"],
    since: 0,
    limit: 100,
  });
});

test("T4b never-read channels open a limit-100 window; read ones keep 200", () => {
  const [batch] = channelActivityFilterBatches(["read", "never", "zero"], {
    read: 5,
    zero: 0,
  });
  assert.deepEqual(
    batch.map((filter) => [filter["#h"][0], filter.since, filter.limit]),
    [
      ["read", 5, 200],
      ["never", 0, 100],
      // A real marker of 0 is still a marker.
      ["zero", 0, 200],
    ],
  );
});

test("countUnreadFromEvents counts foreign post-marker arrivals only", () => {
  const marker = 100;
  const events = [
    { pubkey: OTHER, createdAt: 101 },
    { pubkey: OTHER, createdAt: 200 },
    { pubkey: OTHER, createdAt: 300 },
    { pubkey: SELF, createdAt: 150 },
    { pubkey: SELF, createdAt: 160 },
    { pubkey: OTHER, createdAt: 100 },
  ];
  // 3 foreign + 2 self + 1 pre-marker (created_at AT the marker is read).
  assert.equal(countUnreadFromEvents(events, marker, SELF), 3);
  // Locked key (selfPubkey null): everything post-marker counts.
  assert.equal(countUnreadFromEvents(events, marker, null), 5);
  // Empty window (quiet since-REQ, fresh marker): zero unread.
  assert.equal(countUnreadFromEvents([], marker, SELF), 0);
});

test("incrementUnreadCount bumps on foreign newer arrivals only", () => {
  const marker = 100;
  // Foreign, post-marker: increments.
  assert.equal(
    incrementUnreadCount(5, { pubkey: OTHER, createdAt: 150 }, marker, SELF),
    6,
  );
  // Self arrival: the sample moves but the count never does.
  assert.equal(
    incrementUnreadCount(5, { pubkey: SELF, createdAt: 150 }, marker, SELF),
    5,
  );
  // Stale (at-or-below-marker) foreign arrival: not unread.
  assert.equal(
    incrementUnreadCount(5, { pubkey: OTHER, createdAt: 100 }, marker, SELF),
    5,
  );
  // First countable arrival on an unsampled channel.
  assert.equal(
    incrementUnreadCount(
      undefined,
      { pubkey: OTHER, createdAt: 150 },
      marker,
      SELF,
    ),
    1,
  );
  // Locked key: self-authorship cannot be distinguished, so it counts.
  assert.equal(
    incrementUnreadCount(5, { pubkey: SELF, createdAt: 150 }, marker, null),
    6,
  );
});

test("resetCountsForMarkerChanges zeroes only channels whose marker moved", () => {
  const counts = new Map([
    ["read-now", 7],
    ["read-before", 4],
    ["untouched", 2],
  ]);
  const next = resetCountsForMarkerChanges(
    counts,
    { "read-now": 90, "read-before": 300, untouched: 50 },
    { "read-now": 200, "read-before": 300, untouched: 50 },
  );
  assert.equal(next.get("read-now"), 0);
  assert.equal(next.get("read-before"), 4);
  assert.equal(next.get("untouched"), 2);
  // A marker absent before but set now reads as moved (0 -> value).
  const firstMark = resetCountsForMarkerChanges(counts, {}, { "read-now": 90 });
  assert.equal(firstMark.get("read-now"), 0);
  // Nothing moved: the SAME map reference comes back.
  const same = resetCountsForMarkerChanges(counts, { a: 5 }, { a: 5 });
  assert.equal(same, counts);
});

test("formatUnreadCount renders the number up to the cap, then 99+", () => {
  assert.equal(UNREAD_COUNT_CAP, 99);
  assert.equal(formatUnreadCount(1), "1");
  assert.equal(formatUnreadCount(42), "42");
  assert.equal(formatUnreadCount(99), "99");
  assert.equal(formatUnreadCount(100), "99+");
  assert.equal(formatUnreadCount(250), "99+");
});

// ---- Counting-feed handler chain (the object session.subscribe receives,
// and the object reconnect replay re-delivers through). Drives the REAL
// factory with React state applied synchronously. ----

function driveFeed(readMarkers, selfPubkey) {
  const activityRef = { current: new Map() };
  let counts = new Map();
  const live = [];
  const handlers = createChannelActivityHandlers({
    activityRef,
    onActivityChange: () => {},
    onLiveArrival: (arrival) => live.push(arrival),
    onUnreadCountsChange: (updater) => {
      counts = updater(counts);
    },
    // The factory takes a GETTER; `markers` stays mutable so a test can
    // move a marker under live handlers, as the hook's ref does.
    readMarkers: readMarkers ? () => markers.current : null,
    selfPubkey,
  });
  const markers = { current: readMarkers };
  return {
    markers,
    handlers,
    counts: () => counts,
    activity: () => activityRef.current,
    live: () => live,
  };
}

test("counting feed re-derives exactly once across a reconnect replay round", () => {
  const marker = 100;
  const feed = driveFeed({ ch1: marker }, SELF);
  const round1 = [101, 102, 103, 104, 105].map((createdAt) =>
    relayEvent({ created_at: createdAt }),
  );
  for (const event of round1) {
    feed.handlers.onEvent(event);
  }
  feed.handlers.onEose();
  assert.equal(feed.counts().get("ch1"), 5);

  // Reconnect replay: the relay re-REQs the same subscription and
  // re-delivers the SAME since-window through the SAME handlers.
  for (const event of round1) {
    feed.handlers.onEvent(event);
  }
  feed.handlers.onEose();
  // THE regression: the delivery-round buffer must not double-derive.
  assert.equal(feed.counts().get("ch1"), 5);
});

test("live arrivals after EOSE, then a full replay, stay exactly-once", () => {
  const marker = 100;
  const feed = driveFeed({ ch1: marker }, SELF);
  const backfill = [101, 102, 103, 104, 105].map((created_at) =>
    relayEvent({ created_at }),
  );
  for (const event of backfill) {
    feed.handlers.onEvent(event);
  }
  feed.handlers.onEose();
  assert.equal(feed.counts().get("ch1"), 5);

  // Two strictly-newer foreign arrivals AFTER EOSE: live increments.
  for (const created_at of [106, 107]) {
    feed.handlers.onEvent(relayEvent({ created_at }));
  }
  assert.equal(feed.counts().get("ch1"), 7);

  // Reconnect: the re-delivered window covers all 7 (they all match since),
  // and the fresh round's EOSE must REPLACE the live-incremented 7 with the
  // derived 7 — not add 7 on top of it.
  for (const created_at of [101, 102, 103, 104, 105, 106, 107]) {
    feed.handlers.onEvent(relayEvent({ created_at }));
  }
  feed.handlers.onEose();
  assert.equal(feed.counts().get("ch1"), 7);
});

test("replayed arrivals never re-fire live handlers; true live ones fire once", () => {
  const marker = 100;
  const feed = driveFeed({ ch1: marker }, SELF);
  // Round 1 is backfill until its EOSE (I2): even 105 beating 101 is not
  // live — it was already in the window the relay is streaming.
  for (const created_at of [101, 105]) {
    feed.handlers.onEvent(relayEvent({ created_at }));
  }
  assert.equal(feed.live().length, 0);
  // Live arrival post-EOSE: one fire.
  feed.handlers.onEose();
  feed.handlers.onEvent(relayEvent({ created_at: 106 }));
  assert.equal(feed.live().length, 1);
  // Replay of everything: the persisted newest sample (106) shields every
  // replayed arrival from the live path.
  for (const created_at of [101, 105, 106]) {
    feed.handlers.onEvent(relayEvent({ created_at }));
  }
  feed.handlers.onEose();
  assert.equal(feed.live().length, 1);
});

test("self arrivals update the sample but never the count, live or replayed", () => {
  const marker = 100;
  const feed = driveFeed({ ch1: marker }, SELF);
  feed.handlers.onEvent(relayEvent({ created_at: 101 }));
  feed.handlers.onEose();
  assert.equal(feed.counts().get("ch1"), 1);
  // A live self arrival strictly newer than the sample.
  feed.handlers.onEvent(relayEvent({ created_at: 110, pubkey: SELF }));
  assert.equal(feed.counts().get("ch1"), 1);
  assert.equal(feed.activity().get("ch1").pubkey, SELF);
  // A replay round that includes the self event: still 1, not 2.
  feed.handlers.onEvent(relayEvent({ created_at: 101 }));
  feed.handlers.onEvent(relayEvent({ created_at: 110, pubkey: SELF }));
  feed.handlers.onEose();
  assert.equal(feed.counts().get("ch1"), 1);
});

test("T4 a marker move under live handlers: <= marker never counts, > marker counts once", () => {
  const feed = driveFeed({ ch1: 100 }, SELF);
  feed.handlers.onEvent(relayEvent({ created_at: 150 }));
  feed.handlers.onEose();
  assert.equal(feed.counts().get("ch1"), 1);
  // The viewer opens ch1: the hook zeroes the count and moves the marker —
  // with NO re-subscription, so these same handlers keep running.
  feed.markers.current = { ch1: 300 };
  // Arrival newer than the sample (150) but at-or-below the new marker.
  feed.handlers.onEvent(relayEvent({ created_at: 300 }));
  assert.equal(feed.counts().get("ch1"), 1, "300 <= marker 300: not unread");
  feed.handlers.onEvent(relayEvent({ created_at: 301 }));
  assert.equal(feed.counts().get("ch1"), 2, "301 > marker: +1");
});

// --- warm tap (background-sync plan §4.2, test T9) ------------------------

function tappedHandlers(onRawEvent) {
  return createChannelActivityHandlers({
    activityRef: { current: new Map() },
    onActivityChange: () => {},
    onLiveArrival: () => {},
    onUnreadCountsChange: () => {},
    readMarkers: () => ({}),
    selfPubkey: SELF,
    onRawEvent,
  });
}

test("T9 a kind-9 for channel X reaches timelineStore.apply with source 'activity'; kind 7 does not", async () => {
  const { warmTap } = await import("./timelineStore.ts");
  const calls = [];
  const fakeStore = {
    apply: (channelId, event, options) =>
      calls.push([channelId, event.id, options.source]),
  };
  const handlers = tappedHandlers(warmTap(fakeStore, "activity"));
  handlers.onEvent(relayEvent({ id: "m1", channelId: "X", created_at: 10 }));
  handlers.onEvent({
    ...relayEvent({ id: "r1", channelId: "X", created_at: 11 }),
    kind: 7,
  });
  // A re-delivered (at-or-below-sample) message is still tapped: the store,
  // not the sample map, decides whether it is new to the timeline.
  handlers.onEvent(relayEvent({ id: "m1", channelId: "X", created_at: 10 }));
  assert.deepEqual(calls, [
    ["X", "m1", "activity"],
    ["X", "m1", "activity"],
  ]);
});

test("T9 the tap into a real store skips the OWNED channel and warms the rest", async () => {
  const { createTimelineStore, warmTap } = await import("./timelineStore.ts");
  const store = createTimelineStore({ flushMs: 60_000 });
  await store.load("open");
  await store.load("other");
  store.setOwner("open");
  const handlers = tappedHandlers(warmTap(store, "activity"));
  handlers.onEvent(relayEvent({ id: "a", channelId: "open", created_at: 5 }));
  handlers.onEvent(relayEvent({ id: "b", channelId: "other", created_at: 5 }));
  assert.equal(store.peek("open").messages.length, 0);
  assert.deepEqual(
    store.peek("other").messages.map((m) => m.id),
    ["b"],
  );
});

// --- silent scheduled wakes (Sam 2026-09-30) -------------------------------

/** buzz-services reminder identity — the wake sender. */
const WAKE_SERVICE =
  "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271";
const AGENT = "agentpubkey";

test("a wake for another member adds no unread and fires no live arrival; the agent's reply does both", () => {
  const feed = driveFeed({ ch1: 100 }, SELF);
  // Human baseline at-or-below the marker: a known sample, nothing unread.
  feed.handlers.onEvent(relayEvent({ id: "base", created_at: 100 }));
  feed.handlers.onEose();
  assert.equal(feed.counts().get("ch1"), 0);
  assert.equal(feed.live().length, 0);

  // The scheduler wakes the agent in the viewer's channel.
  feed.handlers.onEvent(
    relayEvent({
      id: "wake",
      pubkey: WAKE_SERVICE,
      created_at: 110,
      tags: [
        ["h", "ch1"],
        ["p", AGENT],
      ],
    }),
  );
  assert.equal(feed.counts().get("ch1"), 0);
  assert.equal(feed.live().length, 0);
  // The sample (sidebar dot + ordering source) is still the human baseline.
  assert.equal(feed.activity().get("ch1").createdAt, 100);

  // The agent's reply is ordinary conversation: one unread, one toast.
  feed.handlers.onEvent(
    relayEvent({ id: "reply", pubkey: AGENT, created_at: 120 }),
  );
  assert.equal(feed.counts().get("ch1"), 1);
  assert.equal(feed.live().length, 1);
});

test("a wake for another member still reaches the timeline tap", () => {
  const raw = [];
  const handlers = tappedHandlers((event) => raw.push(event.id));
  handlers.onEvent(
    relayEvent({
      id: "wake",
      pubkey: WAKE_SERVICE,
      tags: [
        ["h", "ch1"],
        ["p", AGENT],
      ],
    }),
  );
  assert.deepEqual(raw, ["wake"]);
});

test("a wake that p-tags the viewer counts and fires like any message", () => {
  const feed = driveFeed({ ch1: 100 }, SELF);
  feed.handlers.onEvent(relayEvent({ id: "base", created_at: 100 }));
  feed.handlers.onEose();
  feed.handlers.onEvent(
    relayEvent({
      id: "wake-me",
      pubkey: WAKE_SERVICE,
      created_at: 110,
      tags: [
        ["h", "ch1"],
        ["p", SELF],
      ],
    }),
  );
  assert.equal(feed.counts().get("ch1"), 1);
  assert.equal(feed.live().length, 1);
});

test("a channel read up to a wake still counts and toasts the agent's reply", () => {
  // The only message in the window is the wake itself: there is no human
  // baseline sample for the reply to beat.
  const feed = driveFeed({ ch1: 100 }, SELF);
  feed.handlers.onEvent(
    relayEvent({
      id: "wake",
      pubkey: WAKE_SERVICE,
      created_at: 110,
      tags: [
        ["h", "ch1"],
        ["p", AGENT],
      ],
    }),
  );
  feed.handlers.onEose();
  assert.equal(feed.counts().has("ch1"), false);
  assert.equal(feed.activity().has("ch1"), false);
  assert.equal(feed.live().length, 0);

  feed.handlers.onEvent(
    relayEvent({ id: "reply", pubkey: AGENT, created_at: 120 }),
  );
  assert.equal(feed.counts().get("ch1"), 1);
  assert.equal(feed.live().length, 1);

  // A reconnect replay of both must not count or toast the reply again.
  feed.handlers.onEvent(
    relayEvent({
      id: "wake",
      pubkey: WAKE_SERVICE,
      created_at: 110,
      tags: [
        ["h", "ch1"],
        ["p", AGENT],
      ],
    }),
  );
  feed.handlers.onEvent(
    relayEvent({ id: "reply", pubkey: AGENT, created_at: 120 }),
  );
  assert.equal(feed.counts().get("ch1"), 1);
  assert.equal(feed.live().length, 1);
});

test("a message OLDER than the wake is backfill, not a live arrival", () => {
  const feed = driveFeed({ ch1: 100 }, SELF);
  feed.handlers.onEvent(
    relayEvent({
      id: "wake",
      pubkey: WAKE_SERVICE,
      created_at: 110,
      tags: [
        ["h", "ch1"],
        ["p", AGENT],
      ],
    }),
  );
  feed.handlers.onEvent(relayEvent({ id: "older", created_at: 105 }));
  assert.equal(feed.live().length, 0);
});

// The DM toast feed is a SAMPLING feed (no read markers, limit-1 windows).
// It is silenced only because MessageToasts hands it the viewer's pubkey.
test("sampling feed with a viewer pubkey: a DM wake for another member never toasts, the reply does", () => {
  const feed = driveFeed(null, SELF);
  feed.handlers.onEvent(relayEvent({ id: "base", created_at: 100 }));
  feed.handlers.onEose();
  feed.handlers.onEvent(
    relayEvent({
      id: "wake",
      pubkey: WAKE_SERVICE,
      created_at: 110,
      tags: [
        ["h", "ch1"],
        ["p", AGENT],
      ],
    }),
  );
  assert.equal(feed.live().length, 0);
  feed.handlers.onEvent(
    relayEvent({ id: "reply", pubkey: AGENT, created_at: 120 }),
  );
  assert.equal(feed.live().length, 1);
});

test("sampling feed WITHOUT a viewer pubkey cannot silence a wake (why MessageToasts must pass it)", () => {
  const feed = driveFeed(null, null);
  feed.handlers.onEvent(relayEvent({ id: "base", created_at: 100 }));
  feed.handlers.onEose();
  feed.handlers.onEvent(
    relayEvent({
      id: "wake",
      pubkey: WAKE_SERVICE,
      created_at: 110,
      tags: [
        ["h", "ch1"],
        ["p", AGENT],
      ],
    }),
  );
  assert.equal(feed.live().length, 1);
});

// --- I2: one definition of "live" (LEFT_NAV_ARCHITECTURE_REVIEW.md) --------

test("I2: the first message in a never-messaged conversation is live — it toasts AND counts", () => {
  const feed = driveFeed({}, SELF);
  feed.handlers.onEose(); // empty history
  feed.handlers.onEvent(relayEvent({ id: "first", created_at: 300 }));
  assert.equal(feed.live().length, 1, "toasts with no prior sample to beat");
  assert.equal(feed.counts().get("ch1"), 1, "and the row counts it");
});

test("I2: a window that opened EMPTY at the read marker still toasts the next message", () => {
  // Read up to 500 on another device; the since-window holds nothing.
  const feed = driveFeed({ ch1: 500 }, SELF);
  feed.handlers.onEose();
  feed.handlers.onEvent(relayEvent({ id: "next", created_at: 600 }));
  assert.equal(feed.live().length, 1);
  assert.equal(feed.counts().get("ch1"), 1);
});

test("I2: self and at-or-below-marker arrivals are never news", () => {
  const feed = driveFeed({ ch1: 100 }, SELF);
  feed.handlers.onEose();
  feed.handlers.onEvent(
    relayEvent({ id: "mine", created_at: 200, pubkey: SELF }),
  );
  assert.equal(feed.live().length, 0, "own message: no toast");
  feed.markers.current = { ch1: 400 };
  feed.handlers.onEvent(relayEvent({ id: "read", created_at: 300 }));
  assert.equal(feed.live().length, 0, "already read here: no toast");
  assert.equal(feed.counts().get("ch1") ?? 0, 0, "and no count");
});

test("I1 (handler order): when the live handler runs, the sample already holds the arrival", () => {
  const activityRef = { current: new Map() };
  const seenAtFire = [];
  const handlers = createChannelActivityHandlers({
    activityRef,
    onActivityChange: () => {},
    onLiveArrival: (arrival) =>
      seenAtFire.push(activityRef.current.get(arrival.channelId)?.createdAt),
    onUnreadCountsChange: () => {},
    readMarkers: () => ({ ch1: 100 }),
    selfPubkey: SELF,
  });
  handlers.onEose();
  handlers.onEvent(relayEvent({ id: "m", created_at: 150 }));
  assert.deepEqual(seenAtFire, [150]);
});

test("only kind-9 events become a conversation's sample, whatever the sub delivered (phantom DM, 2026-09-15)", () => {
  const feed = driveFeed({ ch1: 50 }, SELF);
  feed.handlers.onEvent({
    ...relayEvent({ id: "status", created_at: 200, content: "status flip" }),
    kind: 30315,
  });
  feed.handlers.onEvent({
    ...relayEvent({ id: "run", created_at: 300, content: "workflow run" }),
    kind: 44100,
  });
  feed.handlers.onEvent(
    relayEvent({ id: "real", created_at: 100, content: "real message" }),
  );
  feed.handlers.onEose();
  assert.equal(feed.activity().get("ch1").preview, "real message");
  assert.equal(feed.activity().get("ch1").createdAt, 100);
  assert.equal(feed.counts().get("ch1"), 1);
});

test("two different messages in the SAME second both toast and count; a replay of either does neither", () => {
  // created_at is whole seconds: an agent's two quick replies share one.
  const feed = driveFeed({ ch1: 100 }, SELF);
  feed.handlers.onEose();
  feed.handlers.onEvent(relayEvent({ id: "r1", created_at: 200 }));
  feed.handlers.onEvent(relayEvent({ id: "r2", created_at: 200 }));
  assert.equal(feed.live().length, 2, "both toast");
  assert.equal(feed.counts().get("ch1"), 2, "both count");
  assert.equal(
    feed.activity().get("ch1").eventId,
    "r2",
    "newest delivery is the sample",
  );
  // Reconnect replay of both.
  feed.handlers.onEvent(relayEvent({ id: "r1", created_at: 200 }));
  feed.handlers.onEvent(relayEvent({ id: "r2", created_at: 200 }));
  feed.handlers.onEose();
  assert.equal(feed.live().length, 2);
  assert.equal(feed.counts().get("ch1"), 2);
});

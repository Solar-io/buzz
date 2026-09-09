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
  // (the never-read case — the count caps at what limit:200 returns).
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
    limit: 200,
  });
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
    readMarkers,
    selfPubkey,
  });
  return {
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
  // Round 1: first sample is backfill (no live fire), 105 beats it (1 fire).
  for (const created_at of [101, 105]) {
    feed.handlers.onEvent(relayEvent({ created_at }));
  }
  assert.equal(feed.live().length, 1);
  // Live arrival post-EOSE: one more fire.
  feed.handlers.onEose();
  feed.handlers.onEvent(relayEvent({ created_at: 106 }));
  assert.equal(feed.live().length, 2);
  // Replay of everything: the persisted newest sample (106) shields every
  // replayed arrival from the live path.
  for (const created_at of [101, 105, 106]) {
    feed.handlers.onEvent(relayEvent({ created_at }));
  }
  assert.equal(feed.live().length, 2);
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

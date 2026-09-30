import assert from "node:assert/strict";
import test from "node:test";

import { channelMarkers, markerLabel, markersKey } from "./channelMarkers.ts";

const FEED = {
  needs: [
    { kind: "ask", channelId: "flight-path" },
    { kind: "approval", channelId: "ops" },
    { kind: "mention", channelId: "ops" },
    // A reminder does not mark its channel.
    { kind: "feedback", channelId: "flight-path" },
    // Channel-less rows mark nothing.
    { kind: "approval", channelId: null },
    { kind: "feedback", channelId: null },
  ],
  running: [
    { state: "live", channelId: "engineering" },
    { state: "reacting", channelId: "engineering" },
    { state: "live", channelId: "flight-path" },
    // A silent turn is not running.
    { state: "stalled", channelId: "mobile" },
    { state: "lost", channelId: "mobile" },
    // A heartbeat turn has no channel.
    { state: "live", channelId: null },
  ],
};

test("needs outrank running; channel-less rows mark nothing", () => {
  assert.equal(FEED.needs.length, 6, "fixture has need rows");
  assert.equal(FEED.running.length, 6, "fixture has run rows");
  const markers = channelMarkers(FEED);
  assert.deepEqual(
    [...markers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [
      ["engineering", { needs: 0, running: 2 }],
      ["flight-path", { needs: 1, running: 1 }],
      ["ops", { needs: 2, running: 0 }],
    ],
  );
  // Neither a stalled turn nor a null channel created an entry.
  assert.equal(markers.has("mobile"), false);
  assert.equal(markers.size, 3);

  // The row says the need even though an agent is also running there.
  assert.equal(markerLabel(markers.get("flight-path")), "1 needs you");
  assert.equal(markerLabel(markers.get("ops")), "2 need you");
  assert.equal(markerLabel(markers.get("engineering")), "2 agents working");
  assert.equal(markerLabel({ needs: 0, running: 1 }), "1 agent working");
  assert.equal(markerLabel({ needs: 0, running: 0 }), null);
  assert.equal(markerLabel(undefined), null);
});

test("markersKey changes only when a number does", () => {
  const first = markersKey(channelMarkers(FEED));
  const again = markersKey(
    channelMarkers({
      needs: [...FEED.needs].reverse(),
      running: [...FEED.running].reverse(),
    }),
  );
  assert.equal(first, again);
  assert.equal(first, "engineering:0:2|flight-path:1:1|ops:2:0");
  const more = markersKey(
    channelMarkers({
      needs: [...FEED.needs, { kind: "ask", channelId: "ops" }],
      running: FEED.running,
    }),
  );
  assert.notEqual(first, more);
});

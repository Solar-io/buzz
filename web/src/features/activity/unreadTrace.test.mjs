import assert from "node:assert/strict";
import { test } from "node:test";

// The console handle is installed at import time, so the window must exist
// first (as it does in the browser).
const fakeWindow = {};
globalThis.window = fakeWindow;
const { UNREAD_TRACE_LIMIT, clearUnreadTrace, readUnreadTrace, traceUnread } =
  await import("./unreadTrace.ts");

test("trace: window.__buzzUnreadTrace exposes the live trail, oldest first", () => {
  clearUnreadTrace();
  traceUnread({
    type: "markerMoved",
    id: "dm-1",
    from: 10,
    to: 20,
    source: "open",
  });
  traceUnread({
    type: "arrival",
    id: "dm-1",
    eventId: "e1",
    createdAt: 30,
    toasted: true,
    rowUnread: true,
  });
  const dump = fakeWindow.__buzzUnreadTrace;
  assert.equal(dump.length, 2);
  assert.equal(dump[0].source, "open");
  assert.equal(dump[1].type, "arrival");
  assert.equal(typeof dump[0].at, "number");
  // A dump is a copy: a caller cannot rewrite history.
  dump.length = 0;
  assert.equal(readUnreadTrace().length, 2);
});

test("trace: the ring keeps the newest 200 entries", () => {
  clearUnreadTrace();
  assert.equal(UNREAD_TRACE_LIMIT, 200);
  for (let i = 0; i < 250; i += 1) {
    traceUnread({
      type: "markerMoved",
      id: `c${i}`,
      from: null,
      to: i,
      source: "open",
    });
  }
  const trail = readUnreadTrace();
  assert.equal(trail.length, 200);
  assert.equal(trail[0].id, "c50");
  assert.equal(trail[199].id, "c249");
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

// Background-sync plan §4.1 item 0.3 (T4), ported from useChannelActivity
// to the conversation-activity store that replaced it (left-nav phase 1): a
// read-marker move must NOT re-REQ the unread windows. Before the fix every
// subscribed channel's marker move re-subscribed EVERY batch (measured
// ~1.1 MB per channel switch, twice per switch).

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Every session.subscribe call is one REQ frame on the wire. */
const requests = [];
const fakeSession = {
  subscribe(filters, handlers) {
    const request = { filters, handlers, closed: false };
    requests.push(request);
    return () => {
      request.closed = true;
    };
  },
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useConversationActivity, useConversationActivityFeed } = await import(
  "./useConversationActivity.ts"
);

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);
const IDS = ["ch-a", "ch-b", "ch-c"];

function Probe({ markers, onResult }) {
  const store = useConversationActivityFeed({
    session: fakeSession,
    dmIds: [],
    channelIds: IDS,
    selfPubkey: SELF,
    readMarkers: markers,
  });
  onResult(useConversationActivity(store));
  return null;
}

async function mount(markers) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latest;
  const render = async (nextMarkers) => {
    await act(async () => {
      root.render(
        React.createElement(Probe, {
          markers: nextMarkers,
          onResult: (r) => {
            latest = r;
          },
        }),
      );
    });
  };
  await render(markers);
  return {
    render,
    root,
    get result() {
      return latest;
    },
  };
}

function kind9(channelId, createdAt, id) {
  return {
    id,
    kind: 9,
    pubkey: OTHER,
    created_at: createdAt,
    content: "hi",
    tags: [["h", channelId]],
    sig: "s",
  };
}

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.act,
  });
});

test("T4 moving one channel's marker sends 0 new REQs, zeroes it, and later arrivals count against the NEW marker", async () => {
  requests.length = 0;
  const h = await mount({ "ch-a": 100, "ch-b": 100, "ch-c": 100 });
  // Three channels pack into ONE batch (10 filters per REQ).
  assert.equal(requests.length, 1);
  const [req] = requests;

  // Backfill: two foreign unread messages in ch-a, then EOSE.
  await act(async () => {
    req.handlers.onEvent(kind9("ch-a", 150, "e1"));
    req.handlers.onEvent(kind9("ch-a", 160, "e2"));
    req.handlers.onEose();
  });
  assert.equal(h.result.unreadCounts.get("ch-a"), 2);

  // The viewer opens ch-a: its marker moves to 200 (a NEW markers object,
  // as the read-state store produces).
  await h.render({ "ch-a": 200, "ch-b": 100, "ch-c": 100 });
  assert.equal(requests.length, 1, "0 new REQ frames on a marker move");
  assert.equal(req.closed, false, "the batch stays open");
  assert.equal(h.result.unreadCounts.get("ch-a"), 0, "moved channel zeroed");

  // Live on the SAME handlers: at-or-below the new marker is read...
  await act(async () => {
    req.handlers.onEvent(kind9("ch-a", 200, "e3"));
  });
  assert.equal(h.result.unreadCounts.get("ch-a"), 0);
  // ...strictly after it counts once.
  await act(async () => {
    req.handlers.onEvent(kind9("ch-a", 201, "e4"));
  });
  assert.equal(h.result.unreadCounts.get("ch-a"), 1);

  await act(async () => h.root.unmount());
  assert.equal(req.closed, true, "unmount closes the batch");
});

test("T4 a marker landing MID-window recounts from what was seen: 5 unread, marker passes 2 → 3", async () => {
  requests.length = 0;
  const h = await mount({ "ch-a": 100, "ch-b": 100, "ch-c": 100 });
  assert.equal(requests.length, 1);
  const [req] = requests;
  // Two in the backfill, three live after EOSE — the recount must see both.
  await act(async () => {
    req.handlers.onEvent(kind9("ch-a", 101, "m1"));
    req.handlers.onEvent(kind9("ch-a", 102, "m2"));
    req.handlers.onEose();
    req.handlers.onEvent(kind9("ch-a", 103, "m3"));
    req.handlers.onEvent(kind9("ch-a", 104, "m4"));
    req.handlers.onEvent(kind9("ch-a", 105, "m5"));
  });
  assert.equal(h.result.unreadCounts.get("ch-a"), 5);

  // Read state synced from another device: read through 102 only.
  await h.render({ "ch-a": 102, "ch-b": 100, "ch-c": 100 });
  assert.equal(requests.length, 1, "still 0 new REQ frames");
  assert.equal(h.result.unreadCounts.get("ch-a"), 3);

  // A replay round re-delivering the same events must not inflate it.
  await act(async () => {
    for (const [id, at] of [
      ["m1", 101],
      ["m4", 104],
      ["m5", 105],
    ]) {
      req.handlers.onEvent(kind9("ch-a", at, id));
    }
    req.handlers.onEose();
  });
  await h.render({ "ch-a": 103, "ch-b": 100, "ch-c": 100 });
  assert.equal(h.result.unreadCounts.get("ch-a"), 2);

  await act(async () => h.root.unmount());
});

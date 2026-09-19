import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [];
const timers = new Map();
let nextTimer = 0;
dom.window.setInterval = (callback) => {
  timers.set(++nextTimer, callback);
  return nextTimer;
};
dom.window.clearInterval = (id) => timers.delete(id);
globalThis.__BUZZ_TEST_MEMBER_SESSION__ = {
  subscribe(filter, handlers) {
    const request = { filter, handlers, closed: false };
    requests.push(request);
    return () => {
      request.closed = true;
    };
  },
};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_MEMBER_SESSION__ };
    }
  `,
};
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useHuddleMemberSnapshot } = await import(
  "./useHuddleMemberSnapshot.ts"
);
const SELF = "a".repeat(64);
const AGENT = "b".repeat(64);
const OTHER = "c".repeat(64);

function event(room, pubkeys) {
  return {
    kind: 39002,
    tags: [["d", room], ...pubkeys.map((pk) => ["p", pk, "", "bot"])],
  };
}

async function mount(room) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renders = [];
  let snapshot;
  function Probe({ channelId }) {
    snapshot = useHuddleMemberSnapshot(channelId);
    renders.push({
      channelId,
      keys: [...snapshot.members.keys()],
      known: snapshot.known,
    });
    return null;
  }
  const render = async (channelId) => {
    await act(async () =>
      root.render(React.createElement(Probe, { channelId })),
    );
  };
  await render(room);
  return {
    render,
    renders,
    snapshot: () => snapshot,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("member snapshot refresh discovers additions and replaces removals", async () => {
  const mounted = await mount("room-a");
  try {
    await act(async () =>
      requests.at(-1).handlers.onEvent(event("room-a", [SELF])),
    );
    assert.deepEqual([...mounted.snapshot().members.keys()], [SELF]);
    const first = requests.at(-1);
    assert.equal(timers.size, 1);
    await act(async () => [...timers.values()][0]());
    assert.equal(first.closed, true);
    assert.notEqual(requests.at(-1), first);
    await act(async () =>
      requests.at(-1).handlers.onEvent(event("room-a", [SELF, AGENT])),
    );
    assert.deepEqual([...mounted.snapshot().members.keys()], [SELF, AGENT]);
    await act(async () => [...timers.values()][0]());
    await act(async () =>
      requests.at(-1).handlers.onEvent(event("room-a", [SELF])),
    );
    assert.deepEqual([...mounted.snapshot().members.keys()], [SELF]);
  } finally {
    await mounted.close();
  }
  assert.equal(timers.size, 0);
});

test("room switch hides old snapshot immediately and ignores an old add completion", async () => {
  const mounted = await mount("room-a");
  try {
    await act(async () =>
      requests.at(-1).handlers.onEvent(event("room-a", [SELF, AGENT])),
    );
    const staleAddCompletion = mounted.snapshot().merge;
    const oldRequest = requests.at(-1);
    await mounted.render("room-b");
    const firstNewRoom = mounted.renders.find(
      (render) => render.channelId === "room-b",
    );
    assert.deepEqual(firstNewRoom.keys, []);
    assert.equal(firstNewRoom.known, false);
    await act(async () =>
      requests.at(-1).handlers.onEvent(event("room-b", [OTHER])),
    );
    await act(async () =>
      oldRequest.handlers.onEvent(event("room-a", [SELF, AGENT])),
    );
    await act(async () => staleAddCompletion(AGENT, "bot"));
    assert.deepEqual([...mounted.snapshot().members.keys()], [OTHER]);
    await act(async () => mounted.snapshot().merge(SELF, "bot"));
    assert.deepEqual([...mounted.snapshot().members.keys()], [OTHER, SELF]);
  } finally {
    await mounted.close();
  }
});

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.act;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  delete globalThis.__BUZZ_TEST_MEMBER_SESSION__;
  dom.window.close();
});

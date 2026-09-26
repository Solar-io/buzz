import assert from "node:assert/strict";
import { after, test } from "node:test";

// The landing hook driven for real (jsdom + act) with the route's actual
// beforeLoad helper, so the restore → validate → fall back chain is tested
// end to end below the router.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://relay.test/repos",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: dom.window.localStorage,
});
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/lib/relay-url": `
    export function relayWsUrl() { return "wss://relay.test"; }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useLandingConversation } = await import("./useLandingConversation.ts");
const { restoredLandingTarget, consumeRestoredLanding } = await import(
  "./lastConversationScope.ts"
);
const { LAST_CONVERSATION_PREFIX, loadLastConversation } = await import(
  "./lastConversation.ts"
);

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  if (originals.localStorage) {
    Object.defineProperty(globalThis, "localStorage", originals.localStorage);
  } else {
    delete globalThis.localStorage;
  }
  dom.window.close();
});

const KEY = `${LAST_CONVERSATION_PREFIX}wss://relay.test`;

function store(channelId, pubkey = null) {
  dom.window.localStorage.setItem(
    KEY,
    JSON.stringify({ channelId, at: 1, pubkey }),
  );
}

async function mount(initial) {
  const calls = { open: [], clear: 0 };
  let out = null;
  let props = {
    selectedId: undefined,
    view: undefined,
    connected: false,
    channelIds: [],
    samplingSettled: false,
    visibleDms: [],
    hiddenDmIds: [],
    selfPubkey: null,
    openConversation: (id) => calls.open.push(id),
    clearConversation: () => {
      calls.clear += 1;
    },
    ...initial,
  };
  function Probe(p) {
    out = useLandingConversation(p);
    return null;
  }
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Probe, props)));
  return {
    calls,
    out: () => out,
    update: async (patch) => {
      props = { ...props, ...patch };
      await act(async () => root.render(React.createElement(Probe, props)));
    },
    unmount: () => act(async () => root.unmount()),
  };
}

function reset() {
  dom.window.localStorage.clear();
  consumeRestoredLanding();
}

test("bare landing with a stored conversation redirects to it before render", () => {
  reset();
  store("dm-y");
  assert.equal(restoredLandingTarget({}), "dm-y");
  assert.equal(restoredLandingTarget({ c: "dm-x" }), null, "deep link wins");
});

test("valid restore: no skeleton, no D-025 override, choice re-saved", async () => {
  reset();
  store("dm-y");
  restoredLandingTarget({});
  const dms = [
    { lastActivity: 9, channel: { id: "dm-newer" } },
    { lastActivity: 1, channel: { id: "dm-y" } },
  ];
  const h = await mount({
    selectedId: "dm-y",
    channelIds: ["dm-y", "dm-newer"],
    visibleDms: dms,
  });
  try {
    assert.equal(h.out().showSkeleton, false);
    await h.update({ connected: true, samplingSettled: true });
    assert.deepEqual(h.calls.open, [], "D-025 must not bounce a restore");
    assert.equal(h.calls.clear, 0);
    assert.equal(
      loadLastConversation(dom.window.localStorage, "wss://relay.test")
        ?.channelId,
      "dm-y",
    );
  } finally {
    await h.unmount();
  }
});

test("stale restore: skeleton while unsure, then cleared and D-025 takes over", async () => {
  reset();
  store("gone-uuid");
  assert.equal(restoredLandingTarget({}), "gone-uuid");
  const dms = [{ lastActivity: 5, channel: { id: "dm-a" } }];
  const h = await mount({
    selectedId: "gone-uuid",
    channelIds: ["dm-a"],
    visibleDms: dms,
  });
  try {
    assert.equal(h.out().showSkeleton, true, "never 'Pick a channel' here");
    assert.equal(h.calls.clear, 0, "not stale until the list has loaded");
    await h.update({ connected: true, samplingSettled: true });
    assert.equal(h.calls.clear, 1);
    assert.equal(dom.window.localStorage.getItem(KEY), null, "key cleared");
    // The route drops back to a bare /repos…
    await h.update({ selectedId: undefined });
    // …and the unchanged D-025 logic lands in the most recent DM.
    assert.deepEqual(h.calls.open, ["dm-a"]);
  } finally {
    await h.unmount();
  }
});

test("nothing stored: skeleton while D-025 waits; empty state only on stand-down", async () => {
  reset();
  const h = await mount({ channelIds: ["general"] });
  try {
    assert.equal(h.out().showSkeleton, true);
    await h.update({ connected: true, samplingSettled: true });
    assert.equal(h.out().showSkeleton, false, "stood down: no DMs to open");
    assert.deepEqual(h.calls.open, []);
  } finally {
    await h.unmount();
  }
});

test("every selection is remembered for the next load", async () => {
  reset();
  const h = await mount({ selectedId: "general", selfPubkey: "me" });
  try {
    await h.update({ selectedId: "dm-z" });
    assert.deepEqual(
      loadLastConversation(dom.window.localStorage, "wss://relay.test"),
      {
        channelId: "dm-z",
        at: loadLastConversation(dom.window.localStorage, "wss://relay.test")
          .at,
        pubkey: "me",
      },
    );
  } finally {
    await h.unmount();
  }
});

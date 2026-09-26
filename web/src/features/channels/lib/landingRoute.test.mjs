import assert from "node:assert/strict";
import { after, test } from "node:test";

// The landing through a REAL TanStack router (memory history): the shipped
// `landingBeforeLoad` on a /repos route, its redirect, the router re-running
// beforeLoad for the redirected /repos?c=…, and the real landing hook as the
// route component. QA 2026-09-26 found a stale stored id stuck forever
// because the hook-only tests never exercised that second beforeLoad pass.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://relay.test/repos",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const hadSelf = "self" in globalThis;
globalThis.self = dom.window;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
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
const {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useSearch,
} = await import("@tanstack/react-router");
const { landingBeforeLoad } = await import("./lastConversationScope.ts");
const { useLandingConversation } = await import("./useLandingConversation.ts");
const { LAST_CONVERSATION_PREFIX } = await import("./lastConversation.ts");

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (!hadSelf) {
    delete globalThis.self;
  }
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
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
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** World the route component reads; tests mutate it, then rerender. */
const world = {
  connected: false,
  channelsLoaded: false,
  samplingSettled: false,
  channelIds: [],
  visibleDms: [],
  fallbackChannelIds: [],
  skeleton: null,
  rerender: null,
};

function Shell() {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const [, setN] = React.useState(0);
  world.rerender = () => setN((n) => n + 1);
  const { showSkeleton } = useLandingConversation({
    selectedId: search.c,
    view: search.view,
    connected: world.connected,
    channelsLoaded: world.channelsLoaded,
    channelIds: world.channelIds,
    samplingSettled: world.samplingSettled,
    visibleDms: world.visibleDms,
    fallbackChannelIds: world.fallbackChannelIds,
    hiddenDmIds: world.hiddenDmIds ?? [],
    selfPubkey: "me",
    openConversation: (id) =>
      void navigate({ to: "/repos", search: { c: id }, replace: true }),
    clearConversation: () =>
      void navigate({ to: "/repos", search: {}, replace: true }),
  });
  const known = world.channelIds.includes(search.c);
  world.skeleton = showSkeleton;
  world.picker = !showSkeleton && !known;
  return null;
}

async function boot(path) {
  const rootRoute = createRootRoute();
  const repos = createRoute({
    getParentRoute: () => rootRoute,
    path: "/repos",
    validateSearch: (s) => ({
      c: typeof s.c === "string" ? s.c : undefined,
      view: typeof s.view === "string" ? s.view : undefined,
      m: typeof s.m === "string" ? s.m : undefined,
    }),
    beforeLoad: (ctx) => {
      world.beforeLoadSearches.push(ctx.search.c ?? null);
      landingBeforeLoad(ctx);
    },
    component: Shell,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([repos]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  world.beforeLoadSearches = [];
  // The router's own load + redirect-follow (what <Transitioner> does in the
  // browser): the redirect's navigate re-runs beforeLoad for /repos?c=…,
  // which is exactly the second pass the QA regression lived in.
  await router.load();
  for (let hops = 0; router.state.redirect && hops < 3; hops++) {
    const { href: _href, ...options } = router.state.redirect.options;
    await router.navigate(options);
  }
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(RouterProvider, { router }));
  });
  for (let i = 0; i < 50 && world.rerender === null; i++) {
    await act(async () => tick(10));
  }
  assert.ok(world.rerender, "the route component actually rendered");
  return {
    router,
    c: () => router.state.location.search.c,
    settle: async (patch) => {
      Object.assign(world, patch);
      await act(async () => {
        world.rerender?.();
        await tick(10);
      });
      await act(async () => tick(10));
    },
    unmount: () => act(async () => root.unmount()),
  };
}

function resetWorld() {
  Object.assign(world, {
    rerender: null,
    hiddenDmIds: [],
    connected: false,
    channelsLoaded: false,
    samplingSettled: false,
    channelIds: [],
    visibleDms: [],
    fallbackChannelIds: [],
  });
  dom.window.localStorage.clear();
}

const LOADED = {
  connected: true,
  channelsLoaded: true,
  samplingSettled: true,
  channelIds: ["dm-a", "dm-b", "general"],
  visibleDms: [
    { lastActivity: 9, channel: { id: "dm-a" } },
    { lastActivity: 1, channel: { id: "dm-b" } },
  ],
  fallbackChannelIds: ["general"],
};

test("route flow: a valid stored conversation is the landing, via the redirect", async () => {
  resetWorld();
  dom.window.localStorage.setItem(
    KEY,
    JSON.stringify({ channelId: "dm-b", at: 1, pubkey: "me" }),
  );
  const app = await boot("/repos");
  try {
    assert.equal(app.c(), "dm-b", "redirected before render");
    assert.deepEqual(
      world.beforeLoadSearches.slice(0, 2),
      [null, "dm-b"],
      "beforeLoad ran for /repos and again for the redirect",
    );
    await app.settle(LOADED);
    assert.equal(app.c(), "dm-b", "D-025 did not override it");
  } finally {
    await app.unmount();
  }
});

test("route flow: a stale stored id is cleared and the app lands in the newest DM", async () => {
  resetWorld();
  dom.window.localStorage.setItem(
    KEY,
    JSON.stringify({ channelId: "fake-uuid", at: 1, pubkey: "me" }),
  );
  const app = await boot("/repos");
  try {
    assert.equal(app.c(), "fake-uuid");
    assert.equal(world.skeleton, true, "skeleton, not the picker");
    await app.settle(LOADED);
    assert.equal(app.c(), "dm-a", "fell back to the most recent DM");
    await app.settle({});
    const stored = JSON.parse(dom.window.localStorage.getItem(KEY));
    assert.equal(stored.channelId, "dm-a", "fake id gone from storage");
  } finally {
    await app.unmount();
  }
});

test("route flow: a deep link to a nonexistent id lands in a conversation", async () => {
  resetWorld();
  const app = await boot("/repos?c=nope");
  try {
    await app.settle(LOADED);
    assert.equal(app.c(), "dm-a");
  } finally {
    await app.unmount();
  }
});

test("cold origin: a partial list before EOSE is not a verdict; no picker", async () => {
  resetWorld();
  const app = await boot("/repos");
  try {
    // Connected and the first 39000 has arrived, but the channel list has
    // not EOSE'd and there are no DM samples yet (vacuously "settled").
    await app.settle({
      connected: true,
      samplingSettled: true,
      channelIds: ["general"],
    });
    assert.equal(app.c(), undefined, "must not decide on a partial list");
    assert.equal(world.picker, false, "never the picker while loading");
    await app.settle(LOADED);
    assert.equal(app.c(), "dm-a");
  } finally {
    await app.unmount();
  }
});

test("always land: several DMs with no activity open the first, not the picker", async () => {
  resetWorld();
  const app = await boot("/repos");
  try {
    await app.settle({
      ...LOADED,
      visibleDms: [
        { lastActivity: 0, channel: { id: "dm-a" } },
        { lastActivity: 0, channel: { id: "dm-b" } },
      ],
    });
    assert.equal(app.c(), "dm-a");
  } finally {
    await app.unmount();
  }
});

test("always land: no DMs at all opens the first channel", async () => {
  resetWorld();
  const app = await boot("/repos");
  try {
    await app.settle({ ...LOADED, channelIds: ["general"], visibleDms: [] });
    assert.equal(app.c(), "general");
  } finally {
    await app.unmount();
  }
});

test("route flow: a stored DM that was since hidden is a stale RESTORE (needs the redirect hand-off)", async () => {
  // Only a restore — not a deep link — treats a hidden DM as stale, so this
  // passes only if the restore survives beforeLoad's second pass.
  resetWorld();
  dom.window.localStorage.setItem(
    KEY,
    JSON.stringify({ channelId: "dm-b", at: 1, pubkey: "me" }),
  );
  world.hiddenDmIds = ["dm-b"];
  const app = await boot("/repos");
  try {
    await app.settle(LOADED);
    assert.equal(app.c(), "dm-a");
  } finally {
    await app.unmount();
  }
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/agents/acid",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.self = dom.window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  createRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  RouterContextProvider,
} = await import("@tanstack/react-router");
const { useSettingsNavGuard } = await import("./useSettingsNavGuard.ts");
after(() => dom.window.close());

async function fixture(count, run, busy = false) {
  let guard;
  let discarded = 0;
  function Screen() {
    guard = useSettingsNavGuard({
      count,
      screenName: "Acid Burn",
      busy,
      discard: () => {
        discarded++;
      },
    });
    return h("div", null, guard.open ? guard.prompt : "Editing");
  }
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agent",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/agents/acid"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(h(RouterContextProvider, { router }, h(Screen)));
    });
    await run({
      container,
      router,
      guard: () => guard,
      discarded: () => discarded,
    });
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}
test("switching agent with a dirty draft prompts", async () => {
  await fixture(2, async ({ container, router, guard, discarded }) => {
    let navigation;
    await act(async () => {
      navigation = router.history.push("/agents/nikon");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(guard().open, true);
    assert.equal(container.textContent, "Discard 2 changes to Acid Burn?");
    assert.equal(router.history.location.pathname, "/agents/acid");
    await act(async () => {
      guard().keepEditing();
      await navigation;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(discarded(), 0);
    assert.equal(router.history.location.pathname, "/agents/acid");
  });
});
test("Discard continues the blocked navigation once; clean draft does not prompt", async () => {
  await fixture(1, async ({ router, guard, discarded }) => {
    let navigation;
    await act(async () => {
      navigation = router.history.push("/agents/nikon");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      guard().discardAndProceed();
      await navigation;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(discarded(), 1);
    assert.equal(router.history.location.pathname, "/agents/nikon");
  });
  await fixture(0, async ({ router, guard }) => {
    await act(async () => {
      router.history.push("/agents/nikon");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(guard().open, false);
    assert.equal(router.history.location.pathname, "/agents/nikon");
  });
});
test("a save in flight blocks leaving and cannot be discarded", async () => {
  await fixture(
    2,
    async ({ router, guard, discarded }) => {
      let navigation;
      await act(async () => {
        navigation = router.history.push("/agents/nikon");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(() => guard().discardAndProceed());
      assert.equal(router.history.location.pathname, "/agents/acid");
      assert.equal(discarded(), 0);
      await act(() => guard().keepEditing());
      await navigation;
    },
    true,
  );
});

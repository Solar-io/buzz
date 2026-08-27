import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});

const invokes = [];

let act;
let cleanup;
let createElement;
let fireEvent;
let render;
let waitFor;
let WebPanelBootstrap;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      invokes.push([command, args]);
      return Promise.resolve(null);
    },
  };
  ({ act, cleanup, fireEvent, render, waitFor } = await import(
    "@testing-library/react"
  ));
  ({ createElement } = await import("react"));
  ({ WebPanelBootstrap } = await import("./WebPanelBootstrap.tsx"));
});

after(() => {
  cleanup?.();
  dom.window.close();
});

beforeEach(() => {
  cleanup?.();
  invokes.length = 0;
  dom.window.localStorage.clear();
});

async function withOpenStore(run) {
  const store = await import("./webPanelStore.ts");
  store.resetWebPanelForTests();
  store.restoreWebPanelSessionForTests();
  await run(store);
  store.resetWebPanelForTests();
}

test("login button sends only the panel type id across the IPC boundary", async () => {
  await withOpenStore(async (store) => {
    const view = render(createElement(WebPanelBootstrap));
    await act(async () => {
      store.openWebPanelInstance("files");
    });
    const login = await waitFor(() => {
      const button = view.getByLabelText("Log in to Files");
      assert.ok(button, "login button must mount with the open panel");
      return button;
    });

    fireEvent.click(login);

    // Boot order: the registry load precedes any panel command (the
    // session-restore gate waits on it).
    assert.deepEqual(invokes[0], ["list_custom_panels", {}]);
    const loginInvoke = invokes.find(
      ([command]) => command === "open_web_panel_login",
    );
    assert.ok(loginInvoke, "login invoke must have fired");
    // The contract is id-only: url and title must never ride the invoke.
    const [command, args] = loginInvoke;
    assert.equal(command, "open_web_panel_login");
    assert.deepEqual(Object.keys(args), ["panelId"]);
  });
});

test("closing a tab destroys that instance's native webview", async () => {
  await withOpenStore(async (store) => {
    render(createElement(WebPanelBootstrap));
    await act(async () => {
      store.openWebPanelInstance("files");
      store.openWebPanelInstance("files");
    });
    invokes.length = 0;
    await act(async () => {
      store.closeWebPanelInstance("files-2");
    });
    await waitFor(() => {
      assert.deepEqual(invokes, [
        ["destroy_web_panel", { instanceId: "files-2", panelId: "files" }],
      ]);
    });
  });
});

test("closing the dock destroys every instance's webview", async () => {
  await withOpenStore(async (store) => {
    render(createElement(WebPanelBootstrap));
    await act(async () => {
      store.openWebPanelInstance("files");
      store.openWebPanelInstance("files");
    });
    invokes.length = 0;
    await act(async () => {
      store.setWebPanelMode("closed");
    });
    await waitFor(() => assert.equal(invokes.length, 2));
    const destroyed = invokes.map(([, args]) => args.instanceId).sort();
    assert.deepEqual(destroyed, ["files-1", "files-2"]);
  });
});

test("switching tabs keeps both webviews alive (no destroy)", async () => {
  await withOpenStore(async (store) => {
    render(createElement(WebPanelBootstrap));
    await act(async () => {
      store.openWebPanelInstance("files");
      store.openWebPanelInstance("files");
    });
    invokes.length = 0;
    await act(async () => {
      store.setActiveWebPanelInstance("files-1");
    });
    assert.deepEqual(
      invokes,
      [],
      "tab switch must hide, not destroy — keep-alive is the point of tabs",
    );
    assert.equal(store.getWebPanelSnapshotForTests().instances.length, 2);
  });
});

test("restored sessions mount without boot-blocking", async () => {
  await withOpenStore(async (store) => {
    dom.window.localStorage.setItem(
      "buzz-webpanel-session",
      JSON.stringify({
        version: 1,
        mode: "docked",
        instances: [{ instanceId: "files-4", panelId: "files", height: 410 }],
        activeInstanceId: "files-4",
      }),
    );
    store.restoreWebPanelSessionForTests();
    const view = render(createElement(WebPanelBootstrap));
    await waitFor(() => {
      const substrate = view.container.querySelector(
        ".buzz-webpanel-substrate",
      );
      assert.ok(substrate, "restored session must mount the dock");
      assert.equal(substrate.style.height, "410px");
    });
    assert.equal(view.container.querySelectorAll('[role="tab"]').length, 1);
  });
});

test("session restore waits for the custom registry before restoring custom tabs", async () => {
  // THE boot-order gate: a persisted session referencing an owner-added
  // site must restore only after the registry knows that site, or the tab
  // would be dropped as an unknown panel id.
  const registry = await import("./webPanelRegistry.ts");
  registry.resetWebPanelRegistryForTests();
  let releaseList;
  const listGate = new Promise((resolve) => {
    releaseList = resolve;
  });
  registry.setCustomPanelLoaderForTests(() => listGate);

  const store = await import("./webPanelStore.ts");
  store.resetWebPanelForTests();
  dom.window.localStorage.setItem(
    "buzz-webpanel-session",
    JSON.stringify({
      version: 1,
      mode: "docked",
      instances: [{ instanceId: "site-3-1", panelId: "site-3", height: null }],
      activeInstanceId: "site-3-1",
    }),
  );
  // Re-arm the defer the bootstrap installs at module load.
  store.deferWebPanelRestore();

  const view = render(createElement(WebPanelBootstrap));
  // Registry pending: nothing restores yet (static-only dock closed).
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(
    view.container.querySelectorAll('[role="tab"]').length,
    0,
    "restore must not run while the registry is pending",
  );

  releaseList([{ id: "site-3", label: "Wiki", title: "Wiki" }]);
  await waitFor(() => {
    assert.equal(view.container.querySelectorAll('[role="tab"]').length, 1);
  });
  assert.equal(view.getAllByRole("tab")[0].textContent, "Wiki");
  registry.setCustomPanelLoaderForTests(null);
  registry.resetWebPanelRegistryForTests();
  store.resetWebPanelForTests();
});

test("a removed custom site's tabs are dropped by restore", async () => {
  const registry = await import("./webPanelRegistry.ts");
  registry.resetWebPanelRegistryForTests();
  registry.setCustomPanelLoaderForTests(() =>
    Promise.resolve([{ id: "site-9", label: "Other", title: "Other" }]),
  );
  await registry.customPanelsReady();

  const store = await import("./webPanelStore.ts");
  store.resetWebPanelForTests();
  dom.window.localStorage.setItem(
    "buzz-webpanel-session",
    JSON.stringify({
      version: 1,
      mode: "docked",
      instances: [
        { instanceId: "files-1", panelId: "files", height: null },
        { instanceId: "site-3-1", panelId: "site-3", height: null },
      ],
      activeInstanceId: "site-3-1",
    }),
  );
  store.deferWebPanelRestore();
  store.triggerWebPanelRestore();
  const snapshot = store.getWebPanelSnapshotForTests();
  assert.deepEqual(
    snapshot.instances.map((instance) => instance.instanceId),
    ["files-1"],
    "site-3 is no longer in the store, so its tab must not restore",
  );
  registry.setCustomPanelLoaderForTests(null);
  registry.resetWebPanelRegistryForTests();
  store.resetWebPanelForTests();
});

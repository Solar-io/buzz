/**
 * ClaudePoolAccounts points at usage-hub for real per-account usage/quota
 * (B2): the card must link there, open it through the Tauri opener, and no
 * longer claim quota is unreadable.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const invoked = [];
globalThis.__TAURI_INTERNALS__ = {
  invoke: (command, args) => {
    invoked.push({ command, args });
    if (command.startsWith("plugin:opener")) return Promise.resolve();
    return Promise.reject(new Error(`unmocked: ${command}`));
  },
  transformCallback: () => 1,
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;

let React, act, createRoot, QueryClient, QueryClientProvider, mod;

before(async () => {
  ({ default: React, act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  ));
  mod = await import("./ClaudePoolAccounts.tsx");
});

after(() => dom.window.close());

test("links to usage-hub and opens it with the Tauri opener", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(mod.ClaudePoolAccounts),
      ),
    );
  });

  const link = [...container.querySelectorAll("a")].find((a) =>
    a.textContent.includes("usage-hub"),
  );
  assert.ok(link, "usage-hub link rendered");
  assert.equal(
    link.getAttribute("href"),
    "https://pilot.tailb3d4b8.ts.net:6770",
  );
  assert.equal(
    link.textContent,
    "Real usage and quota per account → usage-hub",
  );
  assert.doesNotMatch(container.textContent, /not exposed by Claude/);

  await act(async () => {
    link.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  const opened = invoked.filter((c) => c.command.startsWith("plugin:opener"));
  assert.equal(opened.length, 1, "opened once via the Tauri opener");
  assert.equal(opened[0].args.url, "https://pilot.tailb3d4b8.ts.net:6770");

  await act(async () => root.unmount());
  client.clear();
});

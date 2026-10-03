/**
 * ClaudePoolsSection points at usage-hub for real per-account usage/quota
 * (B2): once a v3 desktop publishes the sealed pools block, the section
 * links to usage-hub in a new tab and no longer claims quota is unreadable.
 * With no capable desktop it still renders nothing (link included).
 *
 * Boundaries (catalogs, relay session, admin commands, signer) are faked via
 * the test-loader's module-stub seam; the component itself is real.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

globalThis.__POOLS_TEST_CATALOGS__ = [];
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/features/agents/useDesktopCatalogs":
    "export function useDesktopCatalogs() { return globalThis.__POOLS_TEST_CATALOGS__; }",
  "@/shared/api/RelaySessionProvider":
    "export function useRelaySession() { return { session: null, status: 'idle' }; }",
  "@/features/agents/ui/useAdminCommands":
    "export function useAdminCommands() { return { send: async () => {}, pending: [] }; }",
  "@/shared/lib/nostr-signer":
    "export async function ownPubkey() { return null; }\n" +
    "export async function nip44DecryptFrom() { throw new Error('no key'); }\n" +
    "export async function nip44EncryptTo() { throw new Error('unused signer'); }\n" +
    "export async function signNostrEvent() { throw new Error('unused signer'); }",
};

const { default: React, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const mod = await import("./ClaudePoolsSection.tsx");

after(() => dom.window.close());

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(mod.ClaudePoolsSection));
  });
  return { container, root };
}

test("hidden (no usage-hub link) until a v3 desktop publishes pools", async () => {
  globalThis.__POOLS_TEST_CATALOGS__ = [];
  const { container, root } = await render();
  assert.equal(container.innerHTML, "");
  await act(async () => root.unmount());
});

test("links to usage-hub in a new tab and drops the 'no quota read' copy", async () => {
  globalThis.__POOLS_TEST_CATALOGS__ = [
    { machine: "crichton", version: 3, claudePoolsSealed: "sealed" },
  ];
  const { container, root } = await render();
  const link = container.querySelector('[data-testid="usage-hub-link"]');
  assert.ok(link, "usage-hub link rendered");
  assert.equal(
    link.getAttribute("href"),
    "https://pilot.tailb3d4b8.ts.net:6770",
  );
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noreferrer");
  assert.equal(
    link.textContent,
    "Real usage and quota per account → usage-hub",
  );
  assert.doesNotMatch(container.textContent, /exposes\s+no quota read/);
  await act(async () => root.unmount());
});

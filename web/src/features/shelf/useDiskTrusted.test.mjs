import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

/*
 * Verifier finding (2026-10-05): disk trust must come from the viewer's own
 * owner-signed kind-30177 registry, never from the shell's general agent set,
 * which also holds observer-frame keys taken from an unverified `agent` tag.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SELF = "a".repeat(64);
const REGISTERED = "b".repeat(64);
const OBSERVER_ONLY = "c".repeat(64);
globalThis.__DISK_TRUST__ = {
  work: {
    selfPubkey: SELF,
    // The general set the shell hands out: registry ∪ observer-frame keys.
    agentPubkeys: new Set([REGISTERED, OBSERVER_ONLY]),
  },
  registry: [{ pubkey: REGISTERED.toUpperCase(), name: "Gilfoyle" }],
};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/features/work/workContext.ts": `export function useWorkContext() { return globalThis.__DISK_TRUST__.work; }`,
  "@/features/agents/useAgentRegistry": `export function useAgentRegistry() { return globalThis.__DISK_TRUST__.registry; }`,
};
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDiskTrusted } = await import("./useDiskTrusted.ts");
after(() => dom.window.close());

async function trusted(author) {
  let value = null;
  function Probe() {
    value = useDiskTrusted(author);
    return null;
  }
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(React.createElement(Probe)));
  await act(async () => root.unmount());
  node.remove();
  return value;
}

test("a pubkey known only from observer frames is NOT trusted for disk", async () => {
  assert.equal(await trusted(OBSERVER_ONLY), false);
});

test("the viewer and a registered agent are trusted", async () => {
  assert.equal(await trusted(SELF), true);
  assert.equal(await trusted(REGISTERED), true);
  assert.equal(await trusted(null), false);
});

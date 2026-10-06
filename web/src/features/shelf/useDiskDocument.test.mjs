import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

/*
 * The confused-deputy gate (security review, 2026-10-05): a share whose
 * author is neither the viewer nor a known agent must never make this browser
 * call stash with the viewer's session. Driven through the REAL hook with a
 * fetch spy standing in for the network.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useDiskDocument } = await import("./useDiskDocument.ts");
const { diskTrusted } = await import("./lib/diskDocument.ts");
after(() => dom.window.close());

const FILES = "https://crichton.tailb3d4b8.ts.net:6831/";
const PATH = { host: "crichton", path: "/Users/sam/.ssh/authorized_keys" };

async function run(trusted) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  };
  let seen = null;
  function Probe() {
    seen = useDiskDocument(PATH, FILES, trusted).state;
    return null;
  }
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    return { calls, state: seen };
  } finally {
    await act(async () => root.unmount());
    node.remove();
    globalThis.fetch = realFetch;
  }
}

test("a share by someone else never reaches stash", async () => {
  const { calls, state } = await run(false);
  assert.deepEqual(calls, []);
  assert.equal(state.phase, "readonly");
  assert.equal(state.reason, "untrusted-author");
});

test("a trusted share does ask stash (the spy can see requests)", async () => {
  const { calls, state } = await run(true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(`${FILES}api/browser/locate?abs=`));
  assert.equal(state.reason, "signed-out");
});

test("diskTrusted: the viewer's own share or an agent's, nobody else", () => {
  const agents = new Set(["agent"]);
  const isAgent = (pubkey) => agents.has(pubkey);
  assert.equal(diskTrusted("self", "self", isAgent), true);
  assert.equal(diskTrusted("SELF", "self", isAgent), true);
  assert.equal(diskTrusted("agent", "self", isAgent), true);
  assert.equal(diskTrusted("human", "self", isAgent), false);
  assert.equal(diskTrusted(null, "self", isAgent), false);
  assert.equal(diskTrusted("human", null, isAgent), false);
});

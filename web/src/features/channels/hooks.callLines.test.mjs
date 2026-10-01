import assert from "node:assert/strict";
import { test, after } from "node:test";

// The REAL useChannelMessages hook must attribute relay-mirrored voice-call
// lines to their speaker — otherwise every view built on it (channel
// timeline, DM, huddle chat, inbox detail) names the relay instead. Harness
// trimmed from hooks.huddleTranscript.test.mjs.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  fetch: globalThis.fetch,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PARENT = "parent-dm";
const RELAY = "7".repeat(64);
const SAM = "5".repeat(64);
const AGENT = "2".repeat(64);
const IMPOSTOR = "9".repeat(64);

// NIP-11: the relay advertises RELAY as its `self` key.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ name: "test", self: RELAY }), {
    status: 200,
    headers: { "content-type": "application/nostr+json" },
  });

const subscriptions = [];
globalThis.__BUZZ_TEST_SESSION__ = {
  subscribe(filters, options) {
    const subscription = { filters, options };
    subscriptions.push(subscription);
    return () => {
      const index = subscriptions.indexOf(subscription);
      if (index >= 0) subscriptions.splice(index, 1);
    };
  },
};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_SESSION__ };
    }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useChannelMessages } = await import("./hooks.ts");

function callLine(id, signer, actor, content, createdAt) {
  return {
    id,
    kind: 9,
    pubkey: signer,
    created_at: createdAt,
    tags: [
      ["h", PARENT],
      ["actor", actor],
      ["buzz-system", "call-line"],
    ],
    content,
    sig: "f".repeat(128),
  };
}

function Harness() {
  const feed = useChannelMessages(PARENT);
  return React.createElement(
    "div",
    null,
    feed.messages.map((message) =>
      React.createElement(
        "div",
        {
          key: message.id,
          "data-testid": `row-${message.id}`,
          "data-author": message.authorPubkey,
        },
        message.content,
      ),
    ),
  );
}

test("the channel hook attributes relay call lines to their speakers", async () => {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const subscription = subscriptions.find((candidate) =>
    JSON.stringify(candidate.filters).includes(PARENT),
  );
  assert.ok(subscription, "the real hook subscribed to the parent");

  await act(async () => {
    subscription.options.onEvent(
      callLine("sam", RELAY, SAM, "which drill?", 10),
    );
    subscription.options.onEvent(
      callLine("agent", RELAY, AGENT, "The DeWalt 20V.", 11),
    );
    subscription.options.onEvent(
      callLine("forged", IMPOSTOR, SAM, "I never said this", 12),
    );
    // Let the NIP-11 read settle and the view re-derive.
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const row = (id) => container.querySelector(`[data-testid="row-${id}"]`);
  assert.equal(row("sam").dataset.author, SAM);
  assert.equal(row("agent").dataset.author, AGENT);
  assert.equal(row("forged").dataset.author, IMPOSTOR, "signer kept");

  await act(async () => root.unmount());
  container.remove();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    fetch: originals.fetch,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

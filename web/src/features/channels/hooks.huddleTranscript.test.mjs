import assert from "node:assert/strict";
import { test, after } from "node:test";

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

const ROOM = "temporary-room";
const WRONG_ROOM = "another-room";
const HUMAN = "1".repeat(64);
const AGENT = "2".repeat(64);
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

function event(id, channelId, authorPubkey, content) {
  return {
    id,
    kind: 9,
    pubkey: authorPubkey,
    created_at: 1,
    tags: [["h", channelId]],
    content,
    sig: "f".repeat(128),
  };
}

function Harness() {
  const feed = useChannelMessages(ROOM);
  return React.createElement(
    "div",
    { "data-testid": "actual-hook-feed" },
    feed.messages.map((message) =>
      React.createElement(
        "div",
        { key: message.id, "data-testid": `message-row-${message.id}` },
        message.content,
      ),
    ),
  );
}

test("actual channel hook replays room events and rejects a wrong-room mutation", async () => {
  subscriptions.length = 0;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const subscription = subscriptions.find((candidate) =>
    JSON.stringify(candidate.filters).includes(ROOM),
  );
  assert.ok(subscription, "the real hook opened the exact room subscription");
  assert.deepEqual(subscription.filters[0]["#h"], [ROOM]);

  await act(async () => {
    subscription.options.onEvent(event("human", ROOM, HUMAN, "human final"));
    subscription.options.onEvent(event("agent", ROOM, AGENT, "agent reply"));
    subscription.options.onEvent(
      event("wrong", WRONG_ROOM, AGENT, "wrong room must stay hidden"),
    );
  });

  assert.equal(
    container.querySelector('[data-testid="message-row-human"]').textContent,
    "human final",
  );
  assert.equal(
    container.querySelector('[data-testid="message-row-agent"]').textContent,
    "agent reply",
  );
  assert.equal(
    container.querySelector('[data-testid="message-row-wrong"]'),
    null,
  );

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
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "SVGElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Node",
  "NodeFilter",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
])
  globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `export function useRelaySession() { return {session: globalThis.w3Session, status: 'open'}; }`,
  "@/shared/lib/nostr-signer": `export async function ownPubkey() {return 'owner';} export async function nip44EncryptTo(value) {return {ciphertext: value};} export async function nip44DecryptFrom(value) {return {plaintext: value};} export async function signNostrEvent(event) {return {...event, pubkey:'owner', id:'signed', created_at:1, sig:'sig'};}`,
  "@/features/agents/useDesktopCatalogs": `export function useDesktopCatalogs() { return globalThis.w3Catalogs; }`,
  "@/features/agents/ObserverProvider": `export function useObserverStore() { return {byAgent: new Map()}; }`,
  "@tanstack/react-router": `export function useNavigate() {return async (value) => {globalThis.w3Navigation = value;};}`,
  "@/shared/theme/ThemeProvider": `export function useTheme() { return {isDark: true}; }`,
};
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentMembersSection } = await import("./AgentMembersSection.tsx");
const key = (n) => n.toString(16).padStart(64, "0");
const agent = (n) => ({
  pubkey: key(n),
  name: `Agent ${n}`,
  updatedAt: 1,
  model: "opus",
  effort: { acp: "medium" },
  respondTo: "owner-only",
  respondToAllowlist: [],
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const button = (text) =>
  [...document.querySelectorAll("button")].find(
    (element) => element.textContent.trim() === text,
  );
const click = async (element) => {
  assert.ok(element);
  await act(async () => {
    element.click();
    await tick();
  });
};
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await act(tick);
    if (predicate()) return;
  }
  assert.fail("The expected desktop acknowledgement did not settle");
}
async function mount({
  count = 1,
  stale = 0,
  rejectMember = false,
  rejectAck = false,
  autoAck = true,
  canManage = true,
  archived = false,
  pickerOpen = false,
  offline = false,
  channelOwner = false,
} = {}) {
  const registry = Array.from({ length: count + stale + 1 }, (_, n) =>
    agent(n + 1),
  );
  const members = registry.slice(0, count + stale).map(({ pubkey }, index) => ({
    pubkey,
    role: channelOwner && index === count ? "owner" : "bot",
  }));
  globalThis.w3Catalogs = [
    {
      machine: "crichton.local",
      version: 4,
      harnesses: [],
      agents: [
        ...registry.slice(0, count).map((entry) => entry.pubkey),
        registry.at(-1).pubkey,
      ],
      updatedAt: Math.floor(Date.now() / 1000) - (offline ? 8 * 3600 : 0),
    },
  ];
  const subscriptions = new Set(),
    published = [],
    commands = [];
  const emit = (command) => {
    for (const handlers of subscriptions)
      handlers.onEvent?.({
        kind: 24202,
        pubkey: "owner",
        content: JSON.stringify({
          type: "agent_admin_ack",
          requestId: command.requestId,
          ok: !rejectAck,
          error: rejectAck ? "Desktop refused" : undefined,
        }),
      });
  };
  globalThis.w3Session = {
    subscribe(_filter, handlers) {
      subscriptions.add(handlers);
      return () => subscriptions.delete(handlers);
    },
    async publish(event) {
      published.push(event);
      if (event.kind === 24201) {
        const command = JSON.parse(event.content);
        commands.push(command);
        if (autoAck) setTimeout(() => emit(command), 2);
      }
      return {
        ok: !(rejectMember && event.kind === 9000),
        message: "Membership refused",
      };
    },
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let confirmed = "",
    closed = false;
  window.confirm = (text) => {
    confirmed = text;
    return true;
  };
  await act(async () => {
    root.render(
      React.createElement(AgentMembersSection, {
        channelId: "test-channel",
        members,
        people: [],
        profiles: new Map(),
        registry,
        archived,
        canManage,
        isMember: true,
        query: "",
        pickerOpen,
        onPickerClose: () => {
          closed = true;
        },
      }),
    );
    await tick();
  });
  await act(tick);
  return {
    node,
    published,
    commands,
    emit,
    confirmation: () => confirmed,
    closed: () => closed,
    async close() {
      await act(async () => root.unmount());
      node.remove();
      assert.equal(subscriptions.size, 0);
    },
  };
}
test("adding an agent publishes 9000 role=bot then a start command for the same pubkey", async () => {
  const view = await mount({ pickerOpen: true, autoAck: false });
  try {
    // Compare a primitive: printing a failed React DOM object can exhaust the runner.
    assert.equal(
      document.querySelector('[aria-label="Add Agent 1"]') === null,
      true,
    );
    await click(document.querySelector('[aria-label="Add Agent 2"]'));
    assert.deepEqual(
      view.published.map((event) => event.kind),
      [9000, 24201],
    );
    assert.deepEqual(view.published[0].tags, [
      ["h", "test-channel"],
      ["p", key(2)],
      ["role", "bot"],
    ]);
    assert.equal(view.commands[0].request.pubkey, key(2));
    assert.equal(view.commands[0].target, "crichton.local");
    assert.equal(
      view.closed(),
      false,
      "relay acceptance must not close the picker",
    );
    await act(async () => {
      view.emit(view.commands[0]);
      await tick();
    });
    assert.equal(view.closed(), true);
    assert.match(view.node.textContent, /start acknowledged/);
  } finally {
    await view.close();
  }
});
test("a refused membership never sends a desktop start", async () => {
  const view = await mount({ pickerOpen: true, rejectMember: true });
  try {
    await click(document.querySelector('[aria-label="Add Agent 2"]'));
    assert.deepEqual(
      view.published.map((event) => event.kind),
      [9000],
    );
    assert.match(document.body.textContent, /Membership refused/);
    assert.equal(view.closed(), false);
  } finally {
    await view.close();
  }
});
test("desktop refusal keeps an added agent visible as a failed start", async () => {
  const view = await mount({ pickerOpen: true, rejectAck: true });
  try {
    await click(document.querySelector('[aria-label="Add Agent 2"]'));
    await act(tick);
    assert.match(document.body.textContent, /Desktop refused/);
    assert.equal(view.closed(), false);
  } finally {
    await view.close();
  }
});
test("Remove 9 publishes exactly 9 removals after confirm", async () => {
  const view = await mount({ stale: 9 });
  try {
    await click(button("Remove 9"));
    assert.match(view.confirmation(), /Agent 2/);
    assert.match(view.confirmation(), /Agent 10/);
    assert.equal(view.published.length, 9);
    assert.ok(
      view.published.every(
        (event) => event.kind === 9001 && event.tags[0][1] === "test-channel",
      ),
    );
    assert.deepEqual(
      view.published.map((event) => event.tags[1][1]).sort(),
      Array.from({ length: 9 }, (_, n) => key(n + 2)).sort(),
    );
  } finally {
    await view.close();
  }
});
test("cancelled cleanup publishes nothing", async () => {
  const view = await mount({ stale: 9 });
  try {
    window.confirm = () => false;
    await click(button("Remove 9"));
    assert.equal(view.published.length, 0);
  } finally {
    await view.close();
  }
});
test("Start all and Stop all send one targeted command per registered member", async () => {
  const view = await mount({ count: 5, stale: 2 });
  try {
    await click(button("Start all"));
    await until(() => !button("Stop all").disabled);
    assert.equal(view.commands.length, 5);
    await click(button("Stop all"));
    await until(() => !button("Start all").disabled);
    assert.equal(view.commands.length, 10);
    assert.deepEqual(
      view.commands.map((command) => command.action),
      [...Array(5).fill("start"), ...Array(5).fill("stop")],
    );
    assert.ok(
      view.commands.every((command) => command.target === "crichton.local"),
    );
  } finally {
    await view.close();
  }
});
test("archived, non-admin, offline and last-owner channels lock the appropriate controls", async () => {
  for (const props of [
    { archived: true },
    { canManage: false },
    { offline: true },
    { channelOwner: true },
  ]) {
    const view = await mount({ ...props, stale: 1 });
    try {
      if (props.archived) {
        assert.equal(button("Start all").disabled, true);
        assert.equal(button("Remove 1").disabled, true);
      } else if (props.canManage === false) {
        assert.equal(button("Start all"), undefined);
        assert.equal(button("Remove 1"), undefined);
      } else if (props.channelOwner) {
        assert.equal(button("Remove 1").disabled, true);
      } else {
        assert.equal(button("Start all").disabled, true);
        assert.equal(button("Stop all").disabled, true);
        assert.match(button("Start all").title, /Open Buzz Desktop/);
        assert.equal(
          button("Remove 1").disabled,
          false,
          "relay membership cleanup does not require a desktop",
        );
      }
      assert.equal(view.published.length, 0);
    } finally {
      await view.close();
    }
  }
});
after(() => {
  dom.window.close();
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
});

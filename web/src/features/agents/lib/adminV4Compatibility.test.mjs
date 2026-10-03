import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { adminCommandLock } from "./adminCommandLock.ts";
import { desktopControlLock } from "./desktopPresence.ts";

const PK = "cc".repeat(32);
const AGENT = "aa".repeat(32);
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/lib/nostr-signer": `export async function ownPubkey() { return "${PK}"; }
    export async function nip44EncryptTo(text) { return {ciphertext:text}; }
    export async function nip44DecryptFrom(text) { return {plaintext:text}; }
    export async function signNostrEvent(event) { return {...event,pubkey:"${PK}"}; }`,
};
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAdminCommands } = await import("../ui/AgentAdminPanel.tsx");
const { DesktopControlBoundary } = await import(
  "../ui/DesktopControlBoundary.tsx"
);
after(() => dom.window.close());

const catalog = {
  machine: "crichton.local",
  version: 4,
  agents: [AGENT],
  harnesses: [],
  updatedAt: 1,
};
const presence = new Map([
  [catalog.machine, { status: "unknown", missed: 0, lastSeen: null }],
]);
const commands = [
  { action: "create", request: { name: "Test", systemPrompt: "Test" } },
  { action: "update", request: { pubkey: AGENT, name: "Renamed" } },
  ...["delete", "unregister", "start", "stop", "restart"].map((action) => ({
    action,
    request: { pubkey: AGENT },
  })),
  {
    action: "set_claude_pools",
    request: {
      baseHash: "original",
      config: {
        default: "A",
        pools: { A: {} },
        assign: {},
        overflow: { enabled: false, cooldownMinutes: 60 },
      },
    },
  },
];
assert.equal(commands.length, 8);

for (const command of commands) {
  test(`v4 ${command.action} stays enabled and sends through the admin hook`, async () => {
    const published = [];
    const session = {
      subscribe: () => () => {},
      publish: async (event) => {
        published.push(event);
        return { ok: true };
      },
    };
    const options = { target: catalog.machine };
    let admin;
    function Control() {
      admin = useAdminCommands(
        session,
        "open",
        (value, opts) =>
          adminCommandLock(value, opts, [catalog], presence).reason,
      );
      return h(
        DesktopControlBoundary,
        desktopControlLock([catalog], presence, [catalog.machine]),
        h(
          "button",
          { onClick: () => admin.send(command, command.action, options) },
          command.action,
        ),
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() => root.render(h(Control)));
      assert.equal(container.querySelector("fieldset").disabled, false);
      assert.equal(
        container.querySelector("button").matches(":disabled"),
        false,
      );
      await act(async () => container.querySelector("button").click());
      assert.equal(published.length, 1);
      assert.equal(published[0].kind, 24201);
      const envelope = JSON.parse(published[0].content);
      assert.equal(envelope.action, command.action);
      assert.deepEqual(envelope.request, command.request);
      assert.equal(envelope.target, catalog.machine);
      assert.equal(envelope.requires, undefined);
      assert.equal(admin.pending.length, 1);
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  });
}

test("v4 cannot enable a v5-only requirement, even with a forged cap", () => {
  const forged = { ...catalog, caps: ["ping", "update.effort"] };
  assert.equal(
    adminCommandLock(
      commands[1],
      { requires: ["update.effort"] },
      [forged],
      presence,
    ).locked,
    true,
  );
});

test("mixed v4/v5 fleet preserves legacy controls while still checking v5 presence", () => {
  const modern = { ...catalog, machine: "other", version: 5, caps: ["ping"] };
  const catalogs = [catalog, modern];
  const states = new Map(presence);
  states.set("other", { status: "online", lastSeen: 1, missed: 0 });
  assert.equal(
    desktopControlLock(catalogs, states, [catalog.machine, "other"]).locked,
    false,
  );
  states.set("other", { status: "offline", lastSeen: 1, missed: 2 });
  assert.equal(
    adminCommandLock(commands[1], undefined, catalogs, states).locked,
    true,
  );
  assert.equal(
    adminCommandLock(commands[1], { target: catalog.machine }, catalogs, states)
      .locked,
    false,
  );
});

test("stale unregister checks desktop presence without a claiming machine", () => {
  const stale = "dd".repeat(32);
  const command = { action: "unregister", request: { pubkey: stale } };
  assert.equal(
    adminCommandLock(command, undefined, [catalog], presence).locked,
    false,
  );
  const modern = { ...catalog, version: 5, caps: ["ping"] };
  const states = new Map([
    [catalog.machine, { status: "online", missed: 0, lastSeen: 1 }],
  ]);
  assert.equal(
    adminCommandLock(command, undefined, [modern], states).locked,
    false,
  );
  states.set(catalog.machine, { status: "offline", missed: 2, lastSeen: 1 });
  assert.equal(
    adminCommandLock(command, undefined, [modern], states).locked,
    true,
  );
  assert.equal(adminCommandLock(command, undefined, [], states).locked, true);
  for (const action of ["start", "stop", "restart", "update", "delete"])
    assert.equal(
      adminCommandLock(
        { action, request: { pubkey: stale } },
        undefined,
        [catalog],
        presence,
      ).locked,
      true,
      action,
    );
});

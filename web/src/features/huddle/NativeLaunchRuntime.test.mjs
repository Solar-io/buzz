import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

// The buzzweb://call runtime, mounted for real under jsdom + act, with the
// native plugin, relay reads, DM open, router and call owner faked at their
// module boundaries. The pure rules live in lib/launchIntent.test.mjs; this
// file proves the runtime actually USES them in the right order: resolve,
// open the DM, navigate, acknowledge, and only then dial.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://localhost/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: dom.window.localStorage,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SELF = "1".repeat(64);
const GILF = "b".repeat(64);
const ACID = "a".repeat(64);
const DM = "dm-gilfoyle";

const T = {};
globalThis.__LAUNCH_TEST__ = T;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/app/router": `
    export const router = { navigate: async (options) => {
      globalThis.__LAUNCH_TEST__.log.push(["navigate", options.search]);
    } };
  `,
  "@/features/auth/ui/AuthProvider": `
    export function useAuth() { return { canSign: globalThis.__LAUNCH_TEST__.canSign }; }
  `,
  "@/features/dms/hooks": `
    export async function openDm(_session, pubkeys) {
      globalThis.__LAUNCH_TEST__.log.push(["openDm", pubkeys]);
      return globalThis.__LAUNCH_TEST__.dm;
    }
  `,
  "@/features/pulse/lib/relayQuery.ts": `
    export async function queryOnce(_session, filter) {
      return globalThis.__LAUNCH_TEST__.events[filter.kinds[0]] ?? [];
    }
  `,
  "@/shared/api/RelaySessionProvider": `
    const session = { subscribe() { return () => {}; } };
    export function useRelaySession() {
      return { session, status: globalThis.__LAUNCH_TEST__.status };
    }
  `,
  "@/shared/lib/useOwnPubkey": `
    export function useOwnPubkey() { return globalThis.__LAUNCH_TEST__.self; }
  `,
  "@/shared/platform/native": `
    export const isNativeIOS = () => globalThis.__LAUNCH_TEST__.native;
    export const BuzzLaunch = {
      async getIntent() { return { intent: globalThis.__LAUNCH_TEST__.intent }; },
      async acknowledgeIntent({ id }) {
        const t = globalThis.__LAUNCH_TEST__;
        t.log.push(["ack", id]);
        if (t.intent?.id === id) t.intent = null;
      },
      async addListener(_event, listener) {
        globalThis.__LAUNCH_TEST__.launchListener = listener;
        return { remove() {} };
      },
    };
  `,
  "./HuddleSessionProvider": `
    export function useHuddleSession() { return globalThis.__LAUNCH_TEST__.huddle; }
  `,
  sonner: `
    const push = (level) => (title, options) =>
      globalThis.__LAUNCH_TEST__.log.push(["toast." + level, title, options?.description]);
    export const toast = { info: push("info"), error: push("error"), success: push("success") };
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NativeLaunchRuntime } = await import("./NativeLaunchRuntime.tsx");
const { LAST_CALL_AGENT_KEY, NO_LAST_AGENT_MESSAGE } = await import(
  "./lib/launchIntent.ts"
);

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.localStorage)
    Object.defineProperty(globalThis, "localStorage", originals.localStorage);
  else delete globalThis.localStorage;
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
});

const registry = (pubkey, name) => ({
  id: `r-${pubkey}`,
  pubkey: SELF,
  created_at: 100,
  kind: 30177,
  tags: [["d", pubkey]],
  content: JSON.stringify({ name }),
  sig: "s",
});
const joined = (who, room, revision) => ({
  id: `j-${who}-${room}`,
  pubkey: "relay",
  created_at: 100 + revision,
  kind: 48101,
  tags: [
    ["h", DM],
    ["p", who],
  ],
  content: JSON.stringify({
    ephemeral_channel_id: room,
    roster_revision: revision,
  }),
  sig: "s",
});

function huddle(overrides = {}) {
  return {
    active: null,
    directAgentCall: false,
    call: { agentPubkeys: [] },
    setFloating: (value) => T.log.push(["setFloating", value]),
    startAgentCall: async (options) => {
      T.log.push(["startAgentCall", options]);
      return { ok: true, message: "Connected" };
    },
    ...overrides,
  };
}

beforeEach(() => {
  Object.assign(T, {
    log: [],
    native: true,
    canSign: true,
    status: "open",
    self: SELF,
    intent: null,
    dm: { ok: true, channelId: DM, message: "" },
    events: {
      30177: [registry(GILF, "Gilfoyle"), registry(ACID, "Acid Burn")],
      30180: [],
      48101: [],
    },
    huddle: huddle(),
    launchListener: null,
  });
  dom.window.localStorage.clear();
});

const intent = (url, id = "intent-1") => ({ id, url, createdAt: Date.now() });

async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
}

async function mount() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(NativeLaunchRuntime));
  });
  await settle();
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const kinds = () => T.log.map((entry) => entry[0]);

test("a named agent: open the DM, show it, acknowledge, THEN dial", async () => {
  T.intent = intent("buzzweb://call?agent=gilfoyle");
  const unmount = await mount();
  assert.deepEqual(kinds(), ["openDm", "navigate", "ack", "startAgentCall"]);
  assert.deepEqual(T.log[0][1], [GILF]);
  assert.deepEqual(T.log[1][1], { c: DM });
  assert.deepEqual(T.log[3][1], {
    parentChannelId: DM,
    agentPubkey: GILF,
    agentName: "Gilfoyle",
    existingHuddleChannelId: null,
  });
  assert.equal(T.intent, null, "the native intent is cleared");
  await unmount();
});

test("a live room in the DM with the agent is reused, not reprovisioned", async () => {
  T.events[48101] = [
    joined(SELF, "room-live", 1),
    joined(GILF, "room-live", 2),
  ];
  T.intent = intent("buzzweb://call?agent=Gilfoyle");
  const unmount = await mount();
  assert.equal(
    T.log.find((entry) => entry[0] === "startAgentCall")[1]
      .existingHuddleChannelId,
    "room-live",
  );
  await unmount();
});

test("buzzweb://call dials the remembered agent", async () => {
  dom.window.localStorage.setItem(
    LAST_CALL_AGENT_KEY,
    JSON.stringify({ owner: SELF, pubkey: ACID, name: "Acid" }),
  );
  T.intent = intent("buzzweb://call");
  const unmount = await mount();
  assert.deepEqual(kinds(), ["openDm", "navigate", "ack", "startAgentCall"]);
  assert.equal(T.log[3][1].agentPubkey, ACID);
  assert.equal(T.log[3][1].agentName, "Acid Burn");
  await unmount();
});

test("buzzweb://call with no last agent explains, and dials nothing", async () => {
  T.intent = intent("buzzweb://call");
  const unmount = await mount();
  assert.deepEqual(T.log, [
    ["toast.info", NO_LAST_AGENT_MESSAGE, undefined],
    ["ack", "intent-1"],
  ]);
  await unmount();
});

test("an agent outside the owner's registry is refused", async () => {
  T.intent = intent(`buzzweb://call?agent=${"e".repeat(64)}`);
  const unmount = await mount();
  assert.deepEqual(kinds(), ["toast.error", "ack"]);
  await unmount();
});

test("an ambiguous name is refused", async () => {
  T.events[30177].push(registry("c".repeat(64), "gilfoyle"));
  T.intent = intent("buzzweb://call?agent=Gilfoyle");
  const unmount = await mount();
  assert.deepEqual(kinds(), ["toast.error", "ack"]);
  assert.match(T.log[0][2], /More than one/);
  await unmount();
});

test("a malformed intent URL is acknowledged and ignored", async () => {
  T.intent = intent("buzzweb://call?agent=a&agent=b");
  const unmount = await mount();
  assert.deepEqual(T.log, [["ack", "intent-1"]]);
  await unmount();
});

test("already on a call with that agent: show it, never dial again", async () => {
  T.huddle = huddle({
    active: { huddleChannelId: "room-live", parentChannelId: DM },
    directAgentCall: true,
    call: { agentPubkeys: [GILF.toUpperCase()] },
  });
  T.intent = intent("buzzweb://call?agent=Gilfoyle");
  const unmount = await mount();
  assert.deepEqual(T.log, [
    ["navigate", { c: DM }],
    ["setFloating", false],
    ["ack", "intent-1"],
  ]);
  await unmount();
});

test("a DM the relay refuses is reported, acknowledged, and not dialed", async () => {
  T.dm = { ok: false, channelId: null, message: "rate limited" };
  T.intent = intent("buzzweb://call?agent=Gilfoyle");
  const unmount = await mount();
  assert.deepEqual(kinds(), ["openDm", "toast.error", "ack"]);
  assert.equal(T.log[1][2], "rate limited");
  await unmount();
});

test("a warm launch event is consumed once, even when foreground fires too", async () => {
  const unmount = await mount();
  assert.deepEqual(T.log, []);
  T.intent = intent("buzzweb://call?agent=Gilfoyle", "warm");
  T.launchListener(T.intent);
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await settle();
  assert.equal(
    T.log.filter((entry) => entry[0] === "startAgentCall").length,
    1,
  );
  assert.deepEqual(
    T.log.filter((entry) => entry[0] === "ack"),
    [["ack", "warm"]],
  );
  await unmount();
});

test("off iOS the runtime never reads an intent", async () => {
  T.native = false;
  T.intent = intent("buzzweb://call?agent=Gilfoyle");
  const unmount = await mount();
  assert.deepEqual(T.log, []);
  assert.notEqual(T.intent, null);
  await unmount();
});

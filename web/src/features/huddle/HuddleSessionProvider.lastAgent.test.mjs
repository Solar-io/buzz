import assert from "node:assert/strict";
import { after, test } from "node:test";

// `buzzweb://call` dials "the last agent Sam talked to". That default is
// written by the ONE call owner on every successful startAgentCall —
// whichever surface started it — so this mounts the real provider (with the
// audio hook and the call sequence faked) and checks what it leaves behind.

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
const T = { flowResult: { ok: true, message: "Connected" } };
globalThis.__LAST_AGENT_TEST__ = T;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/lib/useOwnPubkey": `export function useOwnPubkey() { return "${SELF}"; }`,
  "@/shared/api/RelaySessionProvider": `
    const session = {};
    export function useRelaySession() { return { session, status: "open" }; }
  `,
  "@/shared/platform/native": `
    export const isNativeIOS = () => false;
    export const BuzzHuddle = {};
  `,
  "./useHuddleCall.ts": `
    const call = {
      channelId: null, parentChannelId: null, connected: false, agentPubkeys: [],
      huddle: { status: "idle", join: async () => {}, supportsVoice: true, error: null },
      voice: { supported: true, setEnabled() {} },
      addAgent: async () => ({ ok: true, message: "" }),
      leave() {},
    };
    export function useHuddleCall() { return call; }
  `,
  "./lib/agentCallFlow.ts": `
    export async function runAgentCallFlow() {
      return globalThis.__LAST_AGENT_TEST__.flowResult;
    }
  `,
  "./lib/huddleLifecycle.ts": "export async function startHuddle() {}",
  "./ui/HuddleFloatingPanel.tsx":
    "export function HuddleFloatingPanel() { return null; }",
  "./ui/HuddlePill.tsx": "export function HuddlePill() { return null; }",
  sonner: "export const toast = { success() {}, error() {}, info() {} };",
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HuddleSessionProvider, useHuddleSession } = await import(
  "./HuddleSessionProvider.tsx"
);
const { readLastCallAgent } = await import("./lib/launchIntent.ts");

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.localStorage)
    Object.defineProperty(globalThis, "localStorage", originals.localStorage);
  else delete globalThis.localStorage;
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
});

async function startCall(agentName) {
  let session = null;
  function Probe() {
    session = useHuddleSession();
    return null;
  }
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        HuddleSessionProvider,
        null,
        React.createElement(Probe),
      ),
    );
  });
  let result;
  await act(async () => {
    result = await session.startAgentCall({
      parentChannelId: "dm-1",
      agentPubkey: GILF.toUpperCase(),
      agentName,
    });
  });
  await act(async () => root.unmount());
  return result;
}

test("a successful agent call becomes the buzzweb://call default", async () => {
  dom.window.localStorage.clear();
  T.flowResult = { ok: true, message: "Connected" };
  const result = await startCall("Gilfoyle");
  assert.equal(result.ok, true);
  assert.deepEqual(readLastCallAgent(dom.window.localStorage, SELF), {
    pubkey: GILF,
    name: "Gilfoyle",
  });
});

test("a failed agent call leaves the previous default alone", async () => {
  dom.window.localStorage.clear();
  T.flowResult = { ok: false, message: "agent offline" };
  const result = await startCall("Gilfoyle");
  assert.equal(result.ok, false);
  assert.equal(readLastCallAgent(dom.window.localStorage, SELF), null);
  // The provider toasted this one itself; buzzweb:// must not toast it again.
  assert.equal(result.notified, true);
});

test("an up-front refusal is NOT marked notified, so the caller shows it", async () => {
  let release;
  T.flowResult = new Promise((resolve) => {
    release = () => resolve({ ok: true, message: "Connected" });
  });
  let session = null;
  function Probe() {
    session = useHuddleSession();
    return null;
  }
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        HuddleSessionProvider,
        null,
        React.createElement(Probe),
      ),
    );
  });
  let first;
  await act(async () => {
    first = session.startAgentCall({
      parentChannelId: "dm-1",
      agentPubkey: GILF,
      agentName: "Gilfoyle",
    });
  });
  let second;
  await act(async () => {
    second = await session.startAgentCall({
      parentChannelId: "dm-2",
      agentPubkey: "c".repeat(64),
      agentName: "Cereal",
    });
  });
  assert.deepEqual(second, {
    ok: false,
    message: "Another call is already starting — try again shortly.",
  });
  release();
  await act(async () => {
    await first;
  });
  await act(async () => root.unmount());
});

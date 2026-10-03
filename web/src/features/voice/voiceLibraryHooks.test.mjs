import assert from "node:assert/strict";
import { after, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const admin =
  "25f1ade509ed6cdbc5cf9856fb4f12bec4d056d19a54143eabec36db9fd2c33c";
globalThis.__LIBRARY_VIEWER__ = admin;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider":
    "export function useRelaySession() { return {session:{subscribe(){return ()=>{};}}}; }",
  "@/shared/lib/useOwnPubkey":
    "export function useOwnPubkey() { return globalThis.__LIBRARY_VIEWER__; }",
  "../../../shared/lib/relay-url.ts":
    'export function speechServiceUrl() { return "https://bridge.test/tts"; }',
};
const { useBridgeVoices, useVoiceLibraryAdmin } = await import("./hooks.ts");
const { invalidateVoiceLibrary } = await import(
  "./lib/voiceLibraryRevision.ts"
);
const originalFetch = globalThis.fetch;
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("library mutations refresh every mounted engine hook and abort stale fetches", async () => {
  let selected = "Old";
  let state;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, signal: options.signal });
    return reply({
      voices: [
        { id: url.includes("fish") ? "fish-id" : "eleven-id", label: selected },
      ],
    });
  };
  function Harness() {
    state = [useBridgeVoices("fish"), useBridgeVoices("eleven")];
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Harness)));
  assert.equal(calls.length, 2);
  assert.deepEqual(
    state.map((s) => s.voices[0].label),
    ["Old", "Old"],
  );
  selected = "New";
  await act(async () => invalidateVoiceLibrary());
  assert.equal(calls.length, 4);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, true);
  assert.deepEqual(
    state.map((s) => s.voices[0].label),
    ["New", "New"],
  );
  await act(async () => root.unmount());
  assert.equal(calls[2].signal.aborted, true);
});
test("library admin affordance uses bridge allowlist and changes with the signed-in identity", async () => {
  let state;
  globalThis.fetch = async () => reply({ libraryAdmins: [admin] });
  function Harness() {
    state = useVoiceLibraryAdmin();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  globalThis.__LIBRARY_VIEWER__ = admin;
  await act(async () => root.render(React.createElement(Harness)));
  assert.deepEqual(state, { isAdmin: true, ready: true });
  globalThis.__LIBRARY_VIEWER__ = "b".repeat(64);
  await act(async () => root.render(React.createElement(Harness)));
  assert.deepEqual(state, { isAdmin: false, ready: true });
  await act(async () => root.unmount());
});
test("unavailable library and absent admin metadata fail visibly and read-only", async () => {
  let state;
  globalThis.fetch = async () =>
    reply({ error: "voice library unreadable" }, 503);
  function Harness() {
    state = [useBridgeVoices("fish"), useVoiceLibraryAdmin()];
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Harness)));
  assert.equal(state[0].ready, true);
  assert.match(state[0].error, /library is unavailable/);
  assert.deepEqual(state[1], { isAdmin: false, ready: true });
  await act(async () => root.unmount());
});
after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__LIBRARY_VIEWER__;
  dom.window.close();
});

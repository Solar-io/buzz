import assert from "node:assert/strict";
import { test } from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of [
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Node",
  "NodeFilter",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "MouseEvent",
  "MutationObserver",
  "getComputedStyle",
])
  globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/theme/ThemeProvider": `export function useTheme() { return { isDark: true }; }`,
  "@/shared/layout/AppShell": `export function usePhoneLayout() { return false; } export function usePhoneBarSlot() { return null; }`,
  "../ChannelHeader": `export function ChannelHeader(props) { return globalThis.__BUZZ_TEST_REACT__.createElement('button', {onClick: () => props.onOpenSettings('about')}, 'Channel settings'); }`,
  "../ChannelMembersButton": `export function ChannelMembersButton() { return null; }`,
  "./MembersTab": `export function MembersTab() { return null; }`,
  "../../hooks.ts": `export async function renameChannel(session, id, name) { return session.publish({kind:9002, tags:[['h',id],['name',name]]}); } export async function deleteChannel(session,id) { return session.publish({kind:9008,tags:[['h',id]]}); } export async function leaveChannel(session,id) { return session.publish({kind:9022,tags:[['h',id]]}); }`,
  "@/features/channel-templates/useChannelTemplates": `export function useChannelTemplates() { return { create: async (draft) => { globalThis.savedTemplate = draft; return null; } }; }`,
  "@/features/canvas/useChannelCanvas": `export function useChannelCanvas() { return {phase:'ready',doc:{content:'# Canvas'}}; }`,
  "@/features/shelf/FileTabsProvider": `export function useFileTabs() { return null; }`,
  "@/features/sidebar/lib/channelMenuItems.ts": `export function evictDeletedChannel() { globalThis.evicted = true; }`,
  "@/shared/api/RelaySessionProvider": `export function useRelaySession() { return { session: globalThis.testSession, status:'open' }; }`,
  "@/shared/lib/nostr-signer": `export async function signNostrEvent(event) { return {...event,id:'signed',pubkey:'self',created_at:1,sig:'sig'}; }`,
};
const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChannelSettingsHeader } = await import("./ChannelSettingsHeader.tsx");
const { channelFromEvent } = await import("../../lib/channelFromEvent.ts");

async function mount(archived = false) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const published = [];
  const timers = [];
  const originalTimeout = window.setTimeout;
  window.setTimeout = (...args) => {
    const timer = originalTimeout(...args);
    timers.push(timer);
    return timer;
  };
  globalThis.testSession = {
    publish: async (event) => {
      published.push(event);
      return { ok: true, message: "" };
    },
  };
  const meta = (extra = []) =>
    channelFromEvent({
      kind: 39000,
      id: "metadata",
      created_at: 1,
      tags: [["d", "w1"], ["name", "W1"], ["closed"], ...extra],
    });
  let channel = meta(archived ? [["archived", "true"]] : []);
  const props = () => ({
    channel,
    title: "W1",
    members: [{ pubkey: "self" }],
    profiles: new Map(),
    selfPubkey: "self",
    agentPubkeys: new Set(),
    dmAgentPubkey: null,
    admin: {
      channelPrefs: { muted: [] },
      refreshChannels() {},
      setChannelPrefs() {},
      onCloseChannel() {},
      setReadState() {},
      onChannelDeleted() {},
    },
  });
  const render = async () =>
    act(async () =>
      root.render(React.createElement(ChannelSettingsHeader, props())),
    );
  await render();
  await act(async () => node.querySelector("button").click());
  return {
    published,
    echo: async (tags) => {
      channel = meta(tags);
      await render();
    },
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
      for (const timer of timers) window.clearTimeout(timer);
      window.setTimeout = originalTimeout;
    },
  };
}
const button = (name) =>
  [...document.querySelectorAll("button")].find((item) =>
    item.textContent.trim().startsWith(name),
  );
test("archive button publishes 9002 archived=true and shows Unarchive after the 39000 update", async () => {
  const view = await mount();
  try {
    await act(async () => button("Archive channel").click());
    assert.equal(view.published.length, 1);
    assert.equal(view.published[0].kind, 9002);
    assert.deepEqual(view.published[0].tags, [
      ["h", "w1"],
      ["archived", "true"],
    ]);
    assert.ok(
      button("Archive channel"),
      "ack alone must not pretend the metadata changed",
    );
    await view.echo([["archived", "true"]]);
    assert.ok(button("Unarchive channel"));
    await act(async () => button("Unarchive channel").click());
    assert.deepEqual(view.published[1].tags, [
      ["h", "w1"],
      ["archived", "false"],
    ]);
  } finally {
    await view.close();
  }
});
test("archived channel disables rename", async () => {
  const view = await mount(true);
  try {
    assert.equal(
      document.querySelector('[aria-label="Edit name"]').disabled,
      true,
    );
    for (const label of [
      "Edit purpose",
      "Visibility",
      "Lifetime",
      "Notifications",
    ])
      assert.equal(
        document.querySelector(`[aria-label="${label}"]`).disabled,
        true,
      );
    for (const label of [
      "Delete channel",
      "Leave channel",
      "Canvas",
      "Save as template",
    ])
      assert.equal(button(label).disabled, true);
    assert.equal(button("Unarchive channel").disabled, false);
  } finally {
    await view.close();
  }
});
test("relay refusals stay visible and do not change the archived state", async () => {
  const view = await mount();
  try {
    globalThis.testSession.publish = async () => ({
      ok: false,
      message: "Only an admin can archive",
    });
    await act(async () => button("Archive channel").click());
    assert.equal(
      document.querySelector('[role="alert"]').textContent,
      "Only an admin can archive",
    );
    assert.ok(button("Archive channel"));
  } finally {
    await view.close();
  }
});
test("Save as template uses the existing store with metadata and canvas", async () => {
  const view = await mount();
  try {
    await act(async () => button("Save as template").click());
    assert.equal(globalThis.savedTemplate.name, "W1");
    assert.equal(globalThis.savedTemplate.canvasTemplate, "# Canvas");
    assert.equal(globalThis.savedTemplate.channelType, "stream");
  } finally {
    await view.close();
  }
});

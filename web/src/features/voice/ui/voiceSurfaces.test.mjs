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
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const id = "0123456789abcdef0123456789abcdef";
const removed = { engine: "fish", key: `fish:${id}` };
const owner = "a".repeat(64);
const agent = "b".repeat(64);
const state = {
  admin: true,
  ready: true,
  voices: ["zed", "bella", "Adam", "Émile", "10 Ten", "2 Two"].map(
    (label, i) => ({ id: `${i}`.padEnd(16, "0"), label }),
  ),
  fish: [],
  assign: new Map([
    [agent, { agentPubkey: agent, selection: removed, label: "Stored Jame" }],
  ]),
  self: new Map([
    [owner, { pubkey: owner, selection: removed, label: "My Jame" }],
  ]),
  adds: [],
  deletes: [],
  previews: [],
  confirms: [],
  queries: [],
};
globalThis.__VOICE_SURFACES__ = state;
globalThis.__VOICE_REACT__ = React;
const hooks = `
  const s = () => globalThis.__VOICE_SURFACES__;
  export function useBridgeVoices(engine) { return { voices: engine === "fish" ? s().fish : s().voices, ready: s().ready, error: null }; }
  export function useChatterboxVoices() { return { voices: s().voices.map((v, i) => ({ key: "chatterbox:v"+i, slug: "v"+i, label: v.label, reserved: false, reservedFor: null, gender: "", style: "" })), ready: true }; }
  export function useVoiceLibraryAdmin() { return { isAdmin: s().admin, ready: true }; }
  export function useAgentVoiceAssignments() { return { byAgent: s().assign, ready: true }; }
  export function useAgentVoiceSelections() { return { byPubkey: s().self, ready: true, agentVoiceSelectionFor: (key) => s().self.get(key)?.selection }; }
`;
const wrappers = `
  const React = globalThis.__VOICE_REACT__;
  const wrap = ({children}) => React.createElement("div", null, children);
  export const Dialog = ({open, children}) => open ? React.createElement("div", null, children) : null;
  export const DialogContent = ({children, ...props}) => React.createElement("div", props, children);
  export const DialogHeader = wrap;
  export const DialogTitle = wrap;
  export const DialogDescription = wrap;
  export const Popover = wrap;
  export const PopoverContent = wrap;
  export const PopoverTrigger = wrap;
`;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../hooks.ts": hooks,
  "@/features/voice/hooks.ts": hooks,
  "@/shared/ui/dialog": wrappers,
  "@/shared/ui/popover": wrappers,
  "@/shared/api/RelaySessionProvider":
    "export function useRelaySession() { return { session: {} }; }",
  "@/features/agents/useAgentRegistry": `export function useAgentRegistry() { return [{pubkey: "${agent}", name:"Jame Agent"}]; }`,
  "@/features/channels/useChannels":
    'export function useChannels() { return {channels:[{id:"room",name:"Audio room"}]}; }',
  "@/features/channels/hooks": `export function useProfiles() { return new Map([["${owner}",{name:"Sam"}]]); }`,
  "../lib/voiceLibraryApi.ts": `
    const s = () => globalThis.__VOICE_SURFACES__;
    export async function listAvailable(engine, query) { s().queries.push([engine,query]); return [{id:"${id}", label:"Public Jame", inLibrary:false}]; }
    export async function addVoice(engine, id) { s().adds.push([engine,id]); s().fish = [{id, label:"Jame"}]; return s().fish; }
    export async function removeVoice(engine, id) { s().deletes.push([engine,id]); s().fish=[]; return []; }
  `,
  "./voicePreview.ts": `export function createVoicePreviewer() { return {preview: (r) => globalThis.__VOICE_SURFACES__.previews.push(r), dispose() {}}; }`,
  "@/features/voice/ui/voicePreview.ts": `export function createVoicePreviewer() { return {preview: (r) => globalThis.__VOICE_SURFACES__.previews.push(r), dispose() {}}; }`,
};
const { VoiceLibraryCard } = await import("./VoiceLibraryCard.tsx");
const { VoicePickerDialog } = await import("./VoicePickerDialog.tsx");
const { VoiceSettingsCard } = await import("./VoiceSettingsCard.tsx");
const { HuddleSettingsPopover } = await import(
  "../../huddle/ui/HuddleSettingsPopover.tsx"
);
async function mount(Component, props = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Component, props)));
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
async function click(node) {
  assert.ok(node);
  await act(async () =>
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
  );
}
const button = (container, text) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
const expected = ["2 Two", "10 Ten", "Adam", "bella", "Émile", "zed"];
const pickerProps = {
  open: true,
  onOpenChange() {},
  onConfirm: async (s, label) => state.confirms.push([s, label]),
};

test("Settings picker, agent assignment and profile picker sort each engine's rendered rows", async () => {
  state.fish = state.voices;
  for (const mode of ["self", "assign"]) {
    const view = await mount(VoicePickerDialog, {
      ...pickerProps,
      mode,
      target: { pubkey: agent, name: "Jame Agent" },
    });
    for (const engine of ["chatterbox", "eleven", "fish"]) {
      await click(
        view.container.querySelector(`[data-testid="voice-engine-${engine}"]`),
      );
      const rows = [
        ...view.container.querySelectorAll('[data-testid="voice-picker-row"]'),
      ];
      assert.equal(rows.length, 6);
      assert.deepEqual(
        rows.map((row) => row.querySelector("span").firstChild.textContent),
        expected,
      );
    }
    await view.unmount();
  }
});
test("removed Fish remains pinned, previewable and confirmable with its stored label", async () => {
  state.fish = state.voices;
  state.previews = [];
  state.confirms = [];
  const view = await mount(VoicePickerDialog, {
    ...pickerProps,
    current: removed,
    currentLabel: "Stored Jame",
  });
  const rows = [
    ...view.container.querySelectorAll('[data-testid="voice-picker-row"]'),
  ];
  assert.equal(rows.length, 7);
  assert.match(rows[0].textContent, /Stored Jame.*not in library/);
  await click(rows[0].querySelector('[data-testid="voice-picker-preview"]'));
  await click(rows[0].querySelector('[data-testid="voice-picker-select"]'));
  await click(
    view.container.querySelector('[data-testid="voice-picker-confirm"]'),
  );
  assert.deepEqual(state.previews.at(-1), removed);
  assert.deepEqual(state.confirms.at(-1), [removed, "Stored Jame"]);
  await view.unmount();
});
test("huddle popover sorts all engines and preserves the removed labelled override", async () => {
  state.fish = state.voices;
  const changes = [];
  const view = await mount(HuddleSettingsPopover, {
    prefs: { voice: null, duplex: "half" },
    onChange: (prefs) => changes.push(prefs),
  });
  for (const engine of ["chatterbox", "eleven", "fish"]) {
    await click(
      view.container.querySelector(`[data-testid="voice-engine-${engine}"]`),
    );
    assert.deepEqual(
      [
        ...view.container.querySelectorAll(
          '[data-testid="huddle-voice-row"] > span',
        ),
      ].map((row) => row.textContent),
      expected,
    );
  }
  await click(
    view.container.querySelector('[data-testid="huddle-voice-select"]'),
  );
  assert.equal(changes[0].voice.engine, "fish");
  assert.equal(changes[0].voice.label, "2 Two");
  await view.unmount();
  const pinned = await mount(HuddleSettingsPopover, {
    prefs: { voice: { ...removed, label: "Stored Jame" }, duplex: "half" },
    onChange() {},
  });
  assert.match(
    pinned.container.querySelector('[data-testid="huddle-voice-row"]')
      .textContent,
    /Stored Jame · not in library/,
  );
  await pinned.unmount();
});
test("Voice library curated lists sort both providers and read-only sessions have no mutation controls", async () => {
  state.fish = state.voices;
  state.admin = false;
  const view = await mount(VoiceLibraryCard);
  for (const provider of ["ElevenLabs", "Fish Audio"]) {
    await click(button(view.container, provider));
    assert.deepEqual(
      [
        ...view.container.querySelectorAll(
          '[data-testid="voice-library-label"]',
        ),
      ].map((row) => row.textContent),
      expected,
    );
  }
  assert.ok(
    view.container.querySelector('[data-testid="voice-library-readonly"]'),
  );
  assert.equal(button(view.container, "Remove"), undefined);
  assert.equal(button(view.container, "Add voice"), undefined);
  await click(button(view.container, "Browse Fish Audio"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal(button(view.container, "Add"), undefined);
  await view.unmount();
  state.admin = true;
});
test("remove confirmation names assignment, self-selection and device room without altering them", async () => {
  state.fish = [{ id, label: "Jame" }];
  state.deletes = [];
  dom.window.localStorage.setItem(
    "buzz.huddle.prefs.room",
    JSON.stringify({ voice: removed, duplex: "half" }),
  );
  const view = await mount(VoiceLibraryCard);
  await click(button(view.container, "Fish Audio"));
  await click(button(view.container, "Remove"));
  const usage = view.container.querySelector(
    '[data-testid="voice-library-usage"]',
  );
  assert.equal(usage.querySelectorAll("li").length, 3);
  assert.match(usage.textContent, /Jame Agent.*Sam.*Audio room/);
  assert.equal(
    state.deletes.length,
    0,
    "confirmation has no write side effect",
  );
  await click(button(view.container, "Remove voice"));
  assert.deepEqual(state.deletes, [["fish", id]]);
  assert.equal(state.assign.size, 1);
  assert.equal(state.self.size, 1);
  assert.equal(
    JSON.parse(dom.window.localStorage.getItem("buzz.huddle.prefs.room")).voice
      .key,
    removed.key,
  );
  await view.unmount();
});
test("provider Browse adds a Fish model to the curated list and self voice badges soft removal", async () => {
  state.fish = [];
  state.adds = [];
  const view = await mount(VoiceLibraryCard);
  await click(button(view.container, "Fish Audio"));
  await click(button(view.container, "Browse Fish Audio"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.ok(
    view.container.querySelector('[aria-label="Search public Fish voices"]'),
  );
  await click(button(view.container, "Add"));
  assert.deepEqual(state.adds, [["fish", id]]);
  assert.equal(
    view.container
      .querySelector('[data-testid="voice-library-curated"]')
      .textContent.includes("Jame"),
    true,
  );
  await view.unmount();
  state.fish = [];
  const self = await mount(VoiceSettingsCard, { selfPubkey: owner });
  assert.match(self.container.textContent, /Fish Audio.*My Jame/);
  assert.equal(
    self.container.querySelector('[data-testid="voice-not-in-library"]')
      .textContent,
    "not in library",
  );
  await self.unmount();
});
after(() => {
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__VOICE_SURFACES__;
  dom.window.close();
});

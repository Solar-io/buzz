import assert from "node:assert/strict";
import { test, after } from "node:test";

// VoicePickerList + VoiceEngineTabs under jsdom + act. The list is the
// picker's whole body — fixture catalog rows and fixture bridge voices in,
// rows with Preview/Select out. The dialog wrapper (radix) and the data
// hooks are composition, not logic, so they are deliberately not mounted.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
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

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { VoicePickerList } = await import("./VoicePickerDialog.tsx");
const { VoiceEngineTabs } = await import("./VoiceEngineTabs.tsx");
const { engineVoiceOptions } = await import("./voicePickerOptions.ts");

// FIXTURES: two catalog rows and three bridge voices, run through the REAL
// engine filter so the test exercises production shaping, not a copy.
const SOURCES = {
  catalogRows: [
    { content: { key: "pocket:azelma", displayName: "Azelma" } },
    { content: { key: "pocket:april", displayName: "April" } },
  ],
  elevenVoices: [
    { id: "T720", label: "Amara" },
    { id: "ZZ11", label: "Rook" },
    { id: "CC22", label: "Wren" },
  ],
};

async function mount(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function list(props) {
  return React.createElement(VoicePickerList, {
    options: engineVoiceOptions("pocket", SOURCES),
    current: undefined,
    onPreview: () => {},
    onSelect: () => {},
    busy: false,
    ready: true,
    engine: "pocket",
    ...props,
  });
}

test("the picker renders the CHOSEN engine's rows and none of the other's", async () => {
  const pocket = await mount(list());
  const pocketRows = [
    ...pocket.container.querySelectorAll('[data-testid="voice-picker-row"]'),
  ];
  // Count guard first: a runner or fixture regression that rendered nothing
  // must fail here, not as a vacuous pass.
  assert.equal(pocketRows.length, 2, "both catalog rows");
  const pocketText = pocket.container.textContent;
  assert.match(pocketText, /Azelma/);
  assert.match(pocketText, /April/);
  assert.ok(!pocketText.includes("Amara"), "no ElevenLabs row under Pocket");
  assert.ok(!pocketText.includes("on-device"), "on-device is gone entirely");
  await pocket.unmount();

  const eleven = await mount(
    list({ options: engineVoiceOptions("eleven", SOURCES), engine: "eleven" }),
  );
  assert.equal(
    eleven.container.querySelectorAll('[data-testid="voice-picker-row"]')
      .length,
    3,
    "all three bridge voices",
  );
  const elevenText = eleven.container.textContent;
  assert.match(elevenText, /Amara/);
  assert.ok(!elevenText.includes("Azelma"), "no Pocket row under ElevenLabs");
  await eleven.unmount();
});

test("every rendered row offers Preview and Select", async () => {
  const { container, unmount } = await mount(list());
  assert.equal(
    container.querySelectorAll('[data-testid="voice-picker-preview"]').length,
    2,
  );
  assert.equal(
    container.querySelectorAll('[data-testid="voice-picker-select"]').length,
    2,
  );
  await unmount();
});

test("the current selection renders as Selected and others as Select", async () => {
  const { container, unmount } = await mount(
    list({ current: { engine: "pocket", key: "pocket:april" } }),
  );
  assert.deepEqual(
    [...container.querySelectorAll('[data-testid="voice-picker-select"]')].map(
      (button) => button.textContent,
    ),
    ["Select", "Selected"],
    "the April row (fixture index 1) is the current selection",
  );
  await unmount();
});

test("a stored on-device selection lights up no row", async () => {
  const { container, unmount } = await mount(
    list({ current: { engine: "local-synth", voiceURI: "uri:samantha" } }),
  );
  assert.deepEqual(
    [...container.querySelectorAll('[data-testid="voice-picker-select"]')].map(
      (button) => button.textContent,
    ),
    ["Select", "Select"],
  );
  await unmount();
});

test("the loading state names itself before EOSE, the empty state after", async () => {
  const loading = await mount(list({ options: [], ready: false }));
  assert.match(loading.container.textContent, /Loading voices/);
  await loading.unmount();

  const empty = await mount(list({ options: [], ready: true }));
  assert.match(
    empty.container.textContent,
    /No Pocket voices are available/,
    "an empty list after EOSE must read as empty, not as loading",
  );
  await empty.unmount();
});

test("the engine tabs offer exactly Pocket and ElevenLabs, and report the active one", async () => {
  const chosen = [];
  const { container, unmount } = await mount(
    React.createElement(VoiceEngineTabs, {
      engine: "pocket",
      onChange: (engine) => chosen.push(engine),
    }),
  );
  const buttons = [
    ...container.querySelectorAll('[data-testid^="voice-engine-"]'),
  ].filter((node) => node.tagName === "BUTTON");
  assert.equal(buttons.length, 2, "two engines, no third");
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ["Pocket", "ElevenLabs"],
  );
  assert.deepEqual(
    buttons.map((button) => button.getAttribute("aria-pressed")),
    ["true", "false"],
    "the active engine is the pressed one",
  );
  await act(async () => {
    buttons[1].dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  assert.deepEqual(chosen, ["eleven"], "clicking ElevenLabs reports it");
  await unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

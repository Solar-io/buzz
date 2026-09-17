import assert from "node:assert/strict";
import { test, after } from "node:test";

// VoicePickerList under jsdom + act. The list is the picker's whole body —
// fixture catalog rows and fake voices in, rows with Preview/Select out.
// The dialog wrapper (radix) and the data hooks are composition, not logic,
// so they are deliberately not mounted here.
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
const { localVoiceOptions, pocketVoiceOptions } = await import(
  "./voicePickerOptions.ts"
);

// FIXTURES: two catalog rows and four fake system voices, run through the
// REAL option builders so the test exercises production shaping, not a copy.
const FIXTURE_CATALOG_ROWS = [
  { content: { key: "pocket:azelma", displayName: "Azelma" } },
  { content: { key: "pocket:april", displayName: "April" } },
];
const FIXTURE_VOICES = [
  { name: "Samantha", lang: "en-US", voiceURI: "uri:samantha" },
  { name: "Aaron", lang: "en-US", voiceURI: "uri:aaron" },
  { name: "Amelie", lang: "fr-CA", voiceURI: "uri:amelie" },
  { name: "Milena", lang: "sl-SI", voiceURI: "uri:milena" },
];
const FIXTURE_OPTIONS = [
  ...pocketVoiceOptions(FIXTURE_CATALOG_ROWS),
  ...localVoiceOptions(FIXTURE_VOICES),
];

async function mountList(props) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(VoicePickerList, {
        options: FIXTURE_OPTIONS,
        current: undefined,
        onPreview: () => {},
        onSelect: () => {},
        busy: false,
        pocketReady: true,
        ...props,
      }),
    );
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

test("the picker renders fixture catalog rows and ONLY English local voices", async () => {
  const { container, unmount } = await mountList();
  const rows = [
    ...container.querySelectorAll('[data-testid="voice-picker-row"]'),
  ];
  // Count guard first: a runner or fixture regression that rendered nothing
  // must fail here, not as a vacuous pass.
  assert.equal(rows.length, 4, "2 pocket rows + 2 English local voices");
  const labels = rows.map((row) => row.querySelector("span").textContent);
  assert.ok(labels[0].startsWith("Azelma"), `got ${labels[0]}`);
  assert.ok(labels[1].startsWith("April"), `got ${labels[1]}`);
  assert.ok(labels[2].startsWith("Aaron"), `got ${labels[2]}`);
  assert.ok(labels[3].startsWith("Samantha"), `got ${labels[3]}`);
  // The English filter is the ruled v1 invariant: Amelie (fr-CA) and Milena
  // (sl-SI) must not appear even though the fake voice list carries them.
  const allText = container.textContent;
  assert.ok(!allText.includes("Amelie"), "non-English voices must be filtered");
  assert.ok(!allText.includes("Milena"), "non-English voices must be filtered");
  // Engine badges tell the reader which engine each row speaks through.
  assert.match(allText, /pocket/);
  assert.match(allText, /on-device/);
  await unmount();
});

test("every rendered row offers Preview and Select", async () => {
  const { container, unmount } = await mountList();
  assert.equal(
    container.querySelectorAll('[data-testid="voice-picker-preview"]').length,
    4,
  );
  assert.equal(
    container.querySelectorAll('[data-testid="voice-picker-select"]').length,
    4,
  );
  await unmount();
});

test("the current selection renders as Selected and others as Select", async () => {
  const { container, unmount } = await mountList({
    current: { engine: "local-synth", voiceURI: "uri:aaron" },
  });
  const buttons = [
    ...container.querySelectorAll('[data-testid="voice-picker-select"]'),
  ];
  const states = buttons.map((button) => button.textContent);
  assert.deepEqual(
    states,
    ["Select", "Select", "Selected", "Select"],
    "the Aaron row (fixture index 2) is the current selection",
  );
  await unmount();
});

test("the loading state names itself before EOSE, the empty state after", async () => {
  const loading = await mountList({ options: [], pocketReady: false });
  assert.match(loading.container.textContent, /Loading voices/);
  await loading.unmount();

  const empty = await mountList({ options: [], pocketReady: true });
  assert.match(
    empty.container.textContent,
    /No English voices available/,
    "an empty list after EOSE must read as empty, not as loading",
  );
  await empty.unmount();
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

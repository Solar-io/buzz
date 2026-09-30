import assert from "node:assert/strict";
import { after, test } from "node:test";

// useComposerSuggestions under jsdom + act — the Composer.test.mjs pattern,
// with a thin harness in place of the composer: the harness owns text and
// caret (as Composer does) and renders the REAL ComposerSuggestionLists from
// the hook's listProps, so assertions read the rendered rows.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
const globalKeysBefore = new Set(Object.getOwnPropertyNames(globalThis));
const FORCE_JSDOM = new Set([
  "Event",
  "EventTarget",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "Node",
  "getComputedStyle",
]);
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "globalThis") {
    continue;
  }
  if (FORCE_JSDOM.has(key) || !(key in globalThis)) {
    try {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => dom.window[key],
      });
    } catch {
      // Non-configurable Node global — not needed here.
    }
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
globalThis.__BUZZ_TEST_REACT__ = React;

const { useComposerSuggestions } = await import("./useComposerSuggestions.ts");
const { ComposerSuggestionLists } = await import(
  "./ComposerSuggestionLists.tsx"
);

after(() => {
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (!globalKeysBefore.has(key)) {
      try {
        delete globalThis[key];
      } catch {
        // Non-configurable — leave it.
      }
    }
  }
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
});

const ALICE = "a".repeat(64);
const ALBERT = "b".repeat(64);
const MEMBERS = [
  { pubkey: ALICE, name: "alice-member" },
  { pubkey: ALBERT, name: "albert-member" },
];
const PROFILES = new Map([
  [ALICE, { displayName: "Alice" }],
  [ALBERT, { displayName: "Albert" }],
]);

async function mount() {
  const picks = [];
  const api = {};
  function Harness() {
    const [state, setState] = React.useState({ text: "", caret: 0 });
    const suggest = useComposerSuggestions({
      text: state.text,
      selection: { start: state.caret, end: state.caret },
      members: MEMBERS,
      profiles: PROFILES,
      applyText: (next) => setState((s) => ({ ...s, text: next })),
      focusAt: (start) => setState((s) => ({ ...s, caret: start })),
      onPickMention: (name, pubkey) => picks.push({ name, pubkey }),
    });
    api.state = state;
    api.type = (text) => setState({ text, caret: text.length });
    api.key = (key) =>
      suggest.onKeyDown({ key, shiftKey: false, preventDefault() {} });
    return React.createElement(
      "div",
      null,
      React.createElement(ComposerSuggestionLists, suggest.listProps),
    );
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  const rows = () =>
    [...container.querySelectorAll("li button")].map((b) =>
      b.textContent.trim(),
    );
  return {
    picks,
    rows,
    get text() {
      return api.state.text;
    },
    type: async (text) => {
      await act(async () => api.type(text));
    },
    key: async (key) => {
      let handled;
      await act(async () => {
        handled = api.key(key);
      });
      return handled;
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('typing "@al" lists matching members, Enter inserts "@Alice " and records the pick', async () => {
  const c = await mount();
  try {
    await c.type("hi @al");
    assert.deepEqual(c.rows(), ["@Alice", "@Albert"]);
    assert.equal(await c.key("Enter"), true, "Enter is the popup's");
    assert.equal(c.text, "hi @Alice ");
    assert.deepEqual(c.picks, [{ name: "Alice", pubkey: ALICE }]);
    assert.deepEqual(c.rows(), [], "the list closes after a pick");
  } finally {
    await c.unmount();
  }
});

test('":smi" lists emoji only when no @ token is open', async () => {
  const c = await mount();
  try {
    await c.type("look :smi");
    const emoji = c.rows();
    assert.ok(emoji.length > 0, "an emoji token opens the emoji list");
    assert.ok(
      emoji.every((row) => row.includes(":smi")),
      `emoji rows: ${emoji.join(" | ")}`,
    );
    assert.equal(await c.key("Enter"), true, "Enter completes the emoji");
    assert.equal(c.text.includes(":smi"), false, `completed: ${c.text}`);
    // An open @ token: mentions own the popup, no emoji rows. (The two token
    // grammars cannot both match at one caret today — a mention token cannot
    // contain ":" and an emoji token cannot contain whitespace — so the
    // precedence guard is belt-and-braces; this pins the observable half.)
    await c.type("@al");
    assert.deepEqual(c.rows(), ["@Alice", "@Albert"]);
  } finally {
    await c.unmount();
  }
});

test("Escape dismisses the mention list until the token changes", async () => {
  const c = await mount();
  try {
    await c.type("@al");
    assert.equal(c.rows().length, 2);
    assert.equal(await c.key("Escape"), true);
    assert.deepEqual(c.rows(), [], "dismissed");
    await c.type("@al");
    assert.deepEqual(c.rows(), [], "the same token stays dismissed");
    await c.type("@ali");
    assert.deepEqual(c.rows(), ["@Alice"], "a changed token re-arms the list");
  } finally {
    await c.unmount();
  }
});

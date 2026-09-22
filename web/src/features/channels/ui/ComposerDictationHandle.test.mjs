import assert from "node:assert/strict";
import { test, after } from "node:test";

// The composer's dictation handle under jsdom + act — the ChannelActionsBar
// harness pattern. The dictation MIC lives on the route-rendered action row,
// so the only way a finalized transcript reaches the draft is through
// `ComposerHandle.appendDictation`; this pins exactly that seam, including
// the spacing/join rules and that dictated text rides the SAME parent
// notification typed text does.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  raf: globalThis.requestAnimationFrame,
};
// jsdom ships no rAF; the composer's caret placement defers one frame.
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(Date.now()), 0);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/lib/useOwnPubkey": `
    export function useOwnPubkey() {
      return null;
    }
  `,
  "@/features/custom-emoji/hooks": `
    export function useCustomEmoji() {
      return [];
    }
  `,
  "@/shared/ui/EmojiPicker": `
    export function EmojiPicker() {
      return null;
    }
  `,
  "@/features/custom-emoji/lib/customEmojiTags": `
    export function buildCustomEmojiTags() {
      return [];
    }
  `,
  "../lib/useComposerLinkPreviews.ts": `
    export function useComposerLinkPreviews() {
      return {
        cards: [],
        suppressed: false,
        suppress() {},
        reset() {},
        tagsFor() {
          return [];
        },
      };
    }
  `,
};

const React = (await import("react")).default;
const { act, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Composer } = await import("./Composer.tsx");

async function mountComposer() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const textChanges = [];
  const ref = createRef();
  await act(async () => {
    root.render(
      React.createElement(Composer, {
        members: [],
        profiles: new Map(),
        ref,
        onTextChange: (text) => textChanges.push(text),
        send: async () => ({ ok: true, message: "" }),
      }),
    );
  });
  return {
    container,
    ref,
    root,
    textChanges,
    textarea: () => container.querySelector('[data-testid="composer-input"]'),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("appendDictation writes finalized utterances into the draft", async () => {
  const mounted = await mountComposer();
  assert.ok(mounted.ref.current, "the composer exposes its imperative handle");

  await act(async () => {
    mounted.ref.current.appendDictation("Hello there");
  });
  assert.equal(mounted.textarea().value, "Hello there");

  // A second utterance is JOINED with one space, not concatenated raw —
  // the STT bridge emits one final per VAD-delimited utterance.
  await act(async () => {
    mounted.ref.current.appendDictation("general Kenobi");
  });
  assert.equal(mounted.textarea().value, "Hello there general Kenobi");

  // Whitespace-only finals (a breath the VAD heard) change nothing.
  await act(async () => {
    mounted.ref.current.appendDictation("   ");
  });
  assert.equal(mounted.textarea().value, "Hello there general Kenobi");

  // Dictated text rides the SAME parent notification typed text does —
  // that is what keeps typing indicators and draft persistence honest.
  assert.deepEqual(mounted.textChanges.slice(-1), [
    "Hello there general Kenobi",
  ]);
  await mounted.unmount();
});

test("appendDictation after typed text adds the separating space", async () => {
  const mounted = await mountComposer();
  const textarea = mounted.textarea();
  // React-controlled input: assign through the prototype's setter so the
  // value change is not silently swallowed by React's own value tracker.
  const setValue = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  await act(async () => {
    setValue.call(textarea, "typed words");
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    mounted.ref.current.appendDictation("then dictated");
  });
  assert.equal(mounted.textarea().value, "typed words then dictated");
  await mounted.unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    requestAnimationFrame: originals.raf,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

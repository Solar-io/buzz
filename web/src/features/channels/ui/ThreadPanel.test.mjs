import assert from "node:assert/strict";
import { test, after } from "node:test";

// ThreadPanel under jsdom + act — the Composer.test.mjs harness, plus a
// ResizeObserver stand-in (jsdom has none; the timeline's recovery watcher
// and virtua both construct one unconditionally) and pretendToBeVisual (the
// auto-tail path schedules requestAnimationFrame on mount).
//
// ONE seam is stubbed: ./ChannelTimeline.tsx. Not because its logic is under
// suspicion but because it is a VList virtualizer, and jsdom has no layout —
// every element measures 0×0 with a null offsetParent, so virtua renders a
// zero-item window and no row would ever mount. The stub keeps the real
// wiring honest in both directions: it renders the REAL MessageRow per
// message (so rows, action bars and the ↩-button gate are the shipped code)
// and it forwards every prop it received onto a global, so the test can
// assert exactly what the panel handed the timeline — the flat list, no
// threadLayout, no onOpenThread. The composer, the rows and the action bars
// are the real components throughout.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos/",
  pretendToBeVisual: true,
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  resizeObserver: globalThis.ResizeObserver,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  toasts: globalThis.__BUZZ_TEST_TOASTS__,
};
const globalKeysBefore = new Set(Object.getOwnPropertyNames(globalThis));
const FORCE_JSOM = new Set([
  "Event",
  "EventTarget",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "getComputedStyle",
]);
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "globalThis") {
    continue;
  }
  if (FORCE_JSOM.has(key) || !(key in globalThis)) {
    try {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => dom.window[key],
      });
    } catch {
      // A non-configurable Node global we must not (and need not) shadow.
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
// No layout engine in jsdom → nothing ever "resizes". A silent observer keeps
// the timeline's watcher effect and virtua's measurement happy — virtua reads
// the constructor off `window`, so it must exist on BOTH globals.
const SilentResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.ResizeObserver = SilentResizeObserver;
dom.window.ResizeObserver = SilentResizeObserver;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  // The timeline seam (see the file docblock): real rows, captured props.
  "./ChannelTimeline.tsx": `
    import { MessageRow } from "@/features/channels/ui/MessageRow.tsx";
    // The real module re-exports these for its callers; the stub must too.
    export { authorLabel } from "@/features/channels/lib/authorLabel.ts";
    export { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar.tsx";
    const React = globalThis.__BUZZ_TEST_REACT__;
    export function ChannelTimeline(props) {
      globalThis.__BUZZ_TEST_TIMELINE_PROPS__ = props;
      return React.createElement(
        "div",
        { "data-testid": "timeline-seam" },
        props.messages.map((message) =>
          React.createElement(MessageRow, {
            key: message.id,
            message,
            profiles: props.profiles,
            grouped: false,
            replyCount: props.replyCounts.get(message.id) ?? 0,
            onOpenThread: props.onOpenThread,
            active: false,
            reactionGroups: [],
            showActions: true,
          }),
        ),
      );
    }
  `,
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
    export function buildReactionEmojiTag(emoji) {
      return ["emoji", emoji];
    }
  `,
  // The real blossom module is import-safe (helpers only; nothing signs or
  // fetches until called), so it is NOT stubbed — keeping its full export
  // list in sync here would be a second surface to maintain.
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
  sonner: `
    export const toast = {
      error() {},
      message() {},
    };
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
globalThis.__BUZZ_TEST_REACT__ = React;
const { timelineMessageFromEvent } = await import("../lib/messageBuffer.ts");
const { TooltipProvider } = await import("@/shared/ui/tooltip");
const { ThreadPanel } = await import("./ThreadPanel.tsx");

const CHANNEL = "test-channel";
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

function channelEvent({ id, pubkey, createdAt, content, tags }) {
  return {
    id,
    pubkey,
    created_at: createdAt,
    kind: 9,
    content,
    tags: [["h", CHANNEL], ...tags],
    sig: "f".repeat(128),
  };
}

// The wire shapes sendChannelMessage emits (see lib/threadTarget.ts): a
// direct reply to the root carries the single ["e", root, "", "reply"] tag;
// a reply to a REPLY carries root + reply markers. The nested event is the
// whole point of this suite — it is what used to render as a collapsed
// sub-branch inside the panel.
function threadFixture() {
  const rootEvent = channelEvent({
    id: "root-event",
    pubkey: ALICE,
    createdAt: 1_000,
    content: "what is the plan?",
    tags: [],
  });
  const directEvent = channelEvent({
    id: "direct-reply",
    pubkey: BOB,
    createdAt: 1_010,
    content: "direct answer",
    tags: [["e", "root-event", "", "reply"]],
  });
  const nestedEvent = channelEvent({
    id: "nested-reply",
    pubkey: CAROL,
    createdAt: 1_020,
    content: "answer to the answer",
    tags: [
      ["e", "root-event", "", "root"],
      ["e", "direct-reply", "", "reply"],
    ],
  });
  const messages = [rootEvent, directEvent, nestedEvent].map(
    timelineMessageFromEvent,
  );
  return { root: messages[0], buffer: messages };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountPanel(options = {}) {
  const { root, buffer } = threadFixture();
  globalThis.__BUZZ_TEST_TOASTS__ = [];
  const sent = [];
  let closed = 0;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      // The app mounts its TooltipProvider at the shell; the rows' timestamp
      // tooltips need it (Radix 1.2 throws without a provider).
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ThreadPanel, {
          root,
          buffer,
          members: [],
          profiles: options.profiles ?? new Map(),
          selfPubkey: null,
          onClose: () => {
            closed += 1;
          },
          send: async (payload) => {
            sent.push(payload);
            return { ok: true, message: "" };
          },
        }),
      ),
    );
  });
  await flush();
  return {
    container,
    sent,
    closed: () => closed,
    type: async (text) => {
      const input = container.querySelector('[data-testid="composer-input"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        ).set.call(input, text);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    send: async () => {
      await act(async () => {
        container
          .querySelector('[aria-label="Send"]')
          .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      await flush();
    },
    unmount: async () => {
      await act(async () => {
        reactRoot.unmount();
      });
      container.remove();
    },
  };
}

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
  globalThis.ResizeObserver = originals.resizeObserver;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.__BUZZ_TEST_TOASTS__ = originals.toasts;
});

// The flat policy (Sam 2026-09-20): one click from the main chat shows the
// whole thread. A reply-to-a-reply is a plain row. The tree rendering this
// replaces fails this suite four ways: the nested row is missing (it sat
// behind a chip), threadLayout arrived with depths and summaries, the
// indent rail rendered, and onOpenThread put the ↩ on every row.
test("every descendant renders as a full row, flat, with no tree affordances", async () => {
  const panel = await mountPanel();
  try {
    for (const id of ["root-event", "direct-reply", "nested-reply"]) {
      assert.ok(
        panel.container.querySelector(`[data-testid="message-row-${id}"]`),
        `the ${id} row renders inside the panel`,
      );
    }
    // What the panel handed the timeline: the whole subtree oldest-first,
    // and NONE of the tree machinery.
    const seamProps = globalThis.__BUZZ_TEST_TIMELINE_PROPS__;
    assert.deepEqual(
      seamProps.messages.map((message) => message.id),
      ["root-event", "direct-reply", "nested-reply"],
      "the rendered list is [root, ...every descendant], oldest first",
    );
    assert.equal(seamProps.flat, true, "the timeline runs in flat mode");
    assert.equal(
      seamProps.threadLayout,
      undefined,
      "no depth/summary layout: the panel builds no tree",
    );
    assert.equal(
      seamProps.onOpenThread,
      undefined,
      "no in-pane thread opener to hand the rows",
    );
    assert.equal(
      panel.container.querySelector('[data-testid="thread-reply-indent"]'),
      null,
      "no depth indent: nesting is not drawn",
    );
    assert.equal(
      panel.container.querySelector('[data-testid="thread-branch-chip"]'),
      null,
      "no collapsed sub-branch chip to click through",
    );
    // No additional layer to open: the in-pane ↩ would promise a mid-thread
    // parent the composer no longer sends, so it must not exist here.
    assert.equal(
      panel.container.querySelector('[aria-label="Reply in thread"]'),
      null,
      "no per-row Reply-in-thread action inside the pane",
    );
    assert.equal(
      panel.container.querySelector('[data-testid^="reply-message-"]'),
      null,
      "the ↩ button (and its testid) is gone from pane rows",
    );
  } finally {
    await panel.unmount();
  }
});

// The composer always answers the THREAD, never a mid-thread parent — even
// though a nested reply is on screen to tempt a target.
test("the pane's composer sends a root-targeted threadRef", async () => {
  const panel = await mountPanel();
  try {
    await panel.type("answering the thread itself");
    await panel.send();
    assert.equal(panel.sent.length, 1, "the send went out once");
    assert.deepEqual(
      panel.sent[0].threadRef,
      { rootId: "root-event", replyToId: "root-event" },
      "both ids name the ROOT — the single [e, root, '', 'reply'] shape",
    );
    // The "Replying in thread — Esc clears" hint line is the composer's
    // mid-thread-target UI (forum still uses it); this pane has no target to
    // pick, so the banner branch must stay dark.
    assert.equal(
      panel.container
        .querySelector('[data-testid="composer-input"]')
        ?.getAttribute("placeholder"),
      "Reply in thread to aaaaaaaa…aaaa",
      "the placeholder names the thread (truncated-pubkey author), not a picked reply",
    );
  } finally {
    await panel.unmount();
  }
});

test("the composer hint names the root author and Esc closes the pane", async () => {
  const panel = await mountPanel({
    profiles: new Map([
      [ALICE, { name: "Alice", displayName: "Alice Coil" }],
      [BOB, { name: "Bob", displayName: "Bob" }],
    ]),
  });
  try {
    const input = panel.container.querySelector(
      '[data-testid="composer-input"]',
    );
    assert.equal(
      input.getAttribute("placeholder"),
      "Reply in thread to Alice Coil",
      "the placeholder names the ROOT author unconditionally",
    );
    await act(async () => {
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    assert.equal(panel.closed(), 1, "Esc closes the pane (no mid-thread level");
  } finally {
    await panel.unmount();
  }
});

// The header still reports the whole subtree even though nothing is collapsed.
test("the header counts every descendant and lists the participants", async () => {
  const panel = await mountPanel();
  try {
    const summary = panel.container.querySelector(
      '[data-testid="thread-summary"]',
    )?.textContent;
    assert.match(summary ?? "", /2/, "the header counts both replies");
    assert.ok(
      panel.container.querySelector('[data-testid="thread-panel"]'),
      "the panel is mounted",
    );
  } finally {
    await panel.unmount();
  }
});

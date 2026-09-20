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

// The two-person shape (Sam 2026-09-20): a root and one reply, no third
// voice — the DM-like thread where the pane must wake the other participant
// without a typed @.
function twoAuthorFixture() {
  const rootEvent = channelEvent({
    id: "root-event",
    pubkey: ALICE,
    createdAt: 1_000,
    content: "dm-ish root",
    tags: [],
  });
  const replyEvent = channelEvent({
    id: "direct-reply",
    pubkey: BOB,
    createdAt: 1_010,
    content: "bob answers",
    tags: [["e", "root-event", "", "reply"]],
  });
  const messages = [rootEvent, replyEvent].map(timelineMessageFromEvent);
  return { root: messages[0], buffer: messages };
}

// Every message is the viewer's own: the solo shape that must NOT auto-tag
// (the only participant to notify would be the sender).
function soloFixture() {
  const rootEvent = channelEvent({
    id: "root-event",
    pubkey: ALICE,
    createdAt: 1_000,
    content: "note to self",
    tags: [],
  });
  const replyEvent = channelEvent({
    id: "direct-reply",
    pubkey: ALICE,
    createdAt: 1_010,
    content: "still me",
    tags: [["e", "root-event", "", "reply"]],
  });
  const messages = [rootEvent, replyEvent].map(timelineMessageFromEvent);
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
  const { root, buffer } = (options.fixture ?? threadFixture)();
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
          members: options.members ?? [],
          profiles: options.profiles ?? new Map(),
          selfPubkey: options.selfPubkey ?? null,
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

// ── Two-person threads auto-notify (Sam 2026-09-20) ─────────────────────
// "if two people are the only ones in the conversation, then I shouldn't
// have to tag them." Every assertion below reads the REAL send payload the
// pane composer handed `send` — the p-tag set is the wake mechanism, so a
// payload without the other author's pubkey is a silent thread, the exact
// bug being guarded against.

test("a two-person thread p-tags the other participant with no @ typed (Bob sending)", async () => {
  const panel = await mountPanel({
    fixture: twoAuthorFixture,
    selfPubkey: BOB,
    profiles: new Map([
      [ALICE, { name: "Alice", displayName: "Alice Coil" }],
      [BOB, { name: "Bob", displayName: "Bob" }],
    ]),
  });
  try {
    assert.match(
      panel.container.querySelector('[data-testid="composer-auto-notify"]')
        ?.textContent ?? "",
      /^Alice Coil will be notified$/,
      "the hint names the other participant by display name",
    );
    await panel.type("no tag needed here");
    await panel.send();
    assert.equal(panel.sent.length, 1);
    assert.deepEqual(
      panel.sent[0].mentionPubkeys,
      [ALICE],
      "Alice rides the p-tag set although nothing in the content mentions her",
    );
    assert.ok(
      !panel.sent[0].content.includes("@"),
      "no @ token was inserted into the content — the tag is payload-only",
    );
  } finally {
    await panel.unmount();
  }
});

test("the auto-tag follows the viewer (Alice sending gets Bob), label falls back to the truncated pubkey", async () => {
  const panel = await mountPanel({
    fixture: twoAuthorFixture,
    selfPubkey: ALICE,
    // No profiles at all: the hint must still say WHO, via the pubkey.
  });
  try {
    assert.match(
      panel.container.querySelector('[data-testid="composer-auto-notify"]')
        ?.textContent ?? "",
      /^bbbbbbbb…bbbb will be notified$/,
      "no profile: the hint names the truncated pubkey",
    );
    await panel.type("bob, you there?");
    await panel.send();
    assert.deepEqual(
      panel.sent[0].mentionPubkeys,
      [BOB],
      "the OTHER author is tagged, not the sender",
    );
  } finally {
    await panel.unmount();
  }
});

test("an explicit @ of the same person dedupes to one p-tag", async () => {
  const panel = await mountPanel({
    fixture: twoAuthorFixture,
    selfPubkey: ALICE,
    members: [{ pubkey: BOB, name: "Bob" }],
    profiles: new Map([[BOB, { name: "Bob", displayName: "Bob" }]]),
  });
  try {
    await panel.type("hey @Bob");
    await panel.send();
    assert.equal(panel.sent.length, 1);
    assert.deepEqual(
      panel.sent[0].mentionPubkeys,
      [BOB],
      "p-tags are a set: resolveMentions produced Bob and the auto-tag added nothing",
    );
  } finally {
    await panel.unmount();
  }
});

test("a three-author thread never auto-tags", async () => {
  const panel = await mountPanel({
    selfPubkey: ALICE,
    profiles: new Map([
      [ALICE, { name: "Alice", displayName: "Alice Coil" }],
      [BOB, { name: "Bob", displayName: "Bob" }],
    ]),
  });
  try {
    assert.ok(
      !panel.container.querySelector('[data-testid="composer-auto-notify"]'),
      "no hint renders — the pane promises nothing about notifications",
    );
    await panel.type("plain text, nobody tagged");
    await panel.send();
    assert.deepEqual(
      panel.sent[0].mentionPubkeys,
      [],
      "three authors: explicit mentions stay the only wake path",
    );
  } finally {
    await panel.unmount();
  }
});

test("a solo thread never auto-tags", async () => {
  const panel = await mountPanel({
    fixture: soloFixture,
    selfPubkey: ALICE,
    profiles: new Map([[ALICE, { name: "Alice", displayName: "Alice Coil" }]]),
  });
  try {
    assert.ok(
      !panel.container.querySelector('[data-testid="composer-auto-notify"]'),
      "no hint: the only author is the sender, nobody to notify",
    );
    await panel.type("talking to myself");
    await panel.send();
    assert.deepEqual(
      panel.sent[0].mentionPubkeys,
      [],
      "a solo thread p-tags nobody",
    );
  } finally {
    await panel.unmount();
  }
});

// The lurker (QA mutation gap): a THIRD identity opened the pane on a
// two-author thread — the viewer authored nothing. They are not "the other
// side" of anybody's conversation, so nobody gets auto-tagged. This is the
// only test that fails when the viewer-is-author half of the gate is
// dropped: the size check alone cannot catch it (the set is still exactly 2).
test("a lurker viewing a two-author thread auto-tags nobody", async () => {
  const panel = await mountPanel({
    fixture: twoAuthorFixture,
    selfPubkey: CAROL,
    profiles: new Map([
      [ALICE, { name: "Alice", displayName: "Alice Coil" }],
      [BOB, { name: "Bob", displayName: "Bob" }],
    ]),
  });
  try {
    assert.ok(
      !panel.container.querySelector('[data-testid="composer-auto-notify"]'),
      "no hint: Carol never posted, so there is no conversation partner to name",
    );
    await panel.type("joining late");
    await panel.send();
    assert.deepEqual(
      panel.sent[0].mentionPubkeys,
      [],
      "neither Alice nor Bob is tagged beyond what the text itself resolves",
    );
  } finally {
    await panel.unmount();
  }
});

// Ordering + dedupe across sources: the explicit @ lands FIRST (it is what
// the author typed), the automatic key APPENDS — a reader of the raw event
// can tell the deliberate tag from the implied one.
test("an explicit third-party mention comes first, the auto-tag appends after it", async () => {
  const panel = await mountPanel({
    fixture: twoAuthorFixture,
    selfPubkey: BOB,
    members: [{ pubkey: CAROL, name: "Carol" }],
    profiles: new Map([[CAROL, { name: "Carol", displayName: "Carol" }]]),
  });
  try {
    await panel.type("cc @Carol");
    await panel.send();
    assert.deepEqual(
      panel.sent[0].mentionPubkeys,
      [CAROL, ALICE],
      "explicit picks keep their position; Alice (the other thread author) appends",
    );
  } finally {
    await panel.unmount();
  }
});

// The deleted-author filter, both sides. threadDescendants keeps deleted rows
// (their children must stay attached), so the author set is computed over
// non-deleted messages only — a deletion must RETRACT the author whose every
// message is gone, but never retract someone who still has a live message.
test("deleted messages drive the author set, not just hide rows", async () => {
  // (a) Alice's ONLY message is deleted: she has left the conversation. The
  // thread is Bob's solo now, and Bob's send tags nobody.
  const soloAfterDeletion = twoAuthorFixture();
  soloAfterDeletion.root.deleted = true;
  const panelA = await mountPanel({
    fixture: () => soloAfterDeletion,
    selfPubkey: BOB,
    profiles: new Map([[BOB, { name: "Bob", displayName: "Bob" }]]),
  });
  try {
    assert.ok(
      !panelA.container.querySelector('[data-testid="composer-auto-notify"]'),
      "no hint: the only surviving author is the sender",
    );
    await panelA.type("anyone there?");
    await panelA.send();
    assert.deepEqual(
      panelA.sent[0].mentionPubkeys,
      [],
      "a deleted root author is not tagged",
    );
  } finally {
    await panelA.unmount();
  }

  // (b) Alice has a deleted reply AND a live root: the deletion hides a row,
  // it does not un-author her. Still a two-person thread — the auto-tag fires.
  const mixedDeletion = twoAuthorFixture();
  const messages = mixedDeletion.buffer;
  const deletedReply = channelEvent({
    id: "deleted-reply",
    pubkey: ALICE,
    createdAt: 1_020,
    content: "retracted",
    tags: [["e", "root-event", "", "reply"]],
  });
  messages.push(timelineMessageFromEvent(deletedReply));
  messages[2].deleted = true;
  const panelB = await mountPanel({
    fixture: () => mixedDeletion,
    selfPubkey: BOB,
    profiles: new Map([[ALICE, { name: "Alice", displayName: "Alice Coil" }]]),
  });
  try {
    assert.match(
      panelB.container.querySelector('[data-testid="composer-auto-notify"]')
        ?.textContent ?? "",
      /^Alice Coil will be notified$/,
      "Alice still counts through her live root",
    );
    await panelB.type("still here");
    await panelB.send();
    assert.deepEqual(
      panelB.sent[0].mentionPubkeys,
      [ALICE],
      "the auto-tag survives a deleted reply by the same author",
    );
  } finally {
    await panelB.unmount();
  }
});

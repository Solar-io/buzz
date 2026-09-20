import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * WIRING, not logic. `cardAnswered.test.mjs` proves the answered rule and
 * `DecisionCard.test.mjs` proves the card renders terminal when it is HANDED
 * an answer. Neither can see whether the timeline actually hands it one.
 *
 * That gap is measured, not hypothetical: on 2026-09-20, deleting
 * `cardAnswer={cardAnswers.get(message.id) ?? null}` from the `MessageRow`
 * call in `ChannelTimeline.tsx` left the whole web suite green (2795/2795)
 * while the live app regressed to an answered card that re-armed itself and
 * could publish a SECOND `done:true` answer to a card the agent had already
 * acted on. Terminal state is derived from the EVENT precisely so a remount
 * cannot lose it — and the derivation is worthless if the prop carrying it is
 * not connected.
 *
 * So this file mounts the REAL hosts over a REAL message buffer and reads
 * what the REAL `DecisionCard` rendered. Two cards go in — one answered by
 * me, one not — because a test where every card is terminal cannot tell a
 * connected prop from a hardcoded one.
 *
 * BOTH hosts are covered, not just the one that regressed: `ChannelTimeline`
 * and `InboxDetailPane` each compute `answeredCardReplies` themselves and
 * each pass the result down through a `cardAnswer` prop, so the same one-line
 * cut is available in two places and was green in both.
 *
 * ## The one stub, and why it is not the thing under test
 *
 * `virtua`'s `VList` is replaced by a pass-through that renders all of its
 * children. jsdom has no layout: every element measures 0×0, so the real
 * VList computes a zero-height viewport and renders a ZERO-item window —
 * measured before this file existed (`container.textContent === ""` with one
 * message in the buffer). A test built on that would assert nothing at all
 * while reporting success, which is the failure shape this file exists to
 * close. The virtualizer is third-party and is not what the mutation breaks;
 * everything between it and the card — the row loop, `answeredCardReplies`,
 * `MessageRow`, `DecisionCard` — is the shipped code.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
  pretendToBeVisual: true,
});
/**
 * Same forced list, and the same reason, as `DecisionCard.test.mjs`: node has
 * its own `Event`/`CustomEvent` classes and an event built from those cannot
 * be dispatched on a jsdom node.
 */
const FORCE_JSDOM = new Set([
  "CustomEvent",
  "Event",
  "EventTarget",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "PointerEvent",
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
      // A non-configurable node global we must not (and need not) shadow.
    }
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.matchMedia ??= () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
globalThis.matchMedia = dom.window.matchMedia;
const SilentResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.ResizeObserver = SilentResizeObserver;
dom.window.ResizeObserver = SilentResizeObserver;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_IDB__ = { data: new Map() };

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  // A session OBJECT, not null: custom-emoji/hooks.ts keys a WeakMap on
  // the session whenever status is "open", and a null key throws
  // "Invalid value used as weak map key" out of a passive effect.
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return {
        session: (globalThis.__BUZZ_TEST_RELAY_SESSION__ ??= {
          subscribe: () => () => {},
          publish: async () => ({ ok: true, message: "" }),
        }),
        status: "open",
      };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  "@/shared/theme/ThemeProvider": `
    export function useTheme() { return { isDark: true }; }
    export function ThemeProvider({ children }) { return children ?? null; }
  `,
  "idb-keyval": `
    const store = globalThis.__BUZZ_TEST_IDB__;
    export async function get(key) { return store.data.get(key); }
    export async function set(key, value) { store.data.set(key, value); }
    export async function del(key) { store.data.delete(key); }
    export async function keys() { return Array.from(store.data.keys()); }
    export async function delMany(list) { for (const k of list) store.data.delete(k); }
  `,
  // The pass-through virtualizer. The handle carries every method the
  // timeline's effects call, so nothing here changes which rows mount — the
  // list simply renders all of them.
  //
  // React comes off a global rather than an `import`: a stub module's URL is
  // `buzz-web-test-stub:virtua`, and node cannot resolve a BARE specifier
  // against a non-file base (`ERR_INVALID_URL: input './package.json'`).
  virtua: `
    const { createElement, forwardRef, useImperativeHandle } =
      globalThis.__BUZZ_TEST_REACT__;
    export const VList = forwardRef(function VList(props, ref) {
      useImperativeHandle(ref, () => ({
        scrollToIndex() {},
        scrollTo() {},
        scrollBy() {},
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        getItemSize: () => 0,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
      }));
      return createElement(
        "div",
        { className: props.className, onScroll: props.onScroll },
        props.children,
      );
    });
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { buildCardTag, parseCardTags } = await import("../lib/decisionCard.ts");
const { buildCardAnswerTag } = await import("../lib/cardAnswerTag.ts");
const { timelineMessageFromEvent } = await import("../lib/messageBuffer.ts");
const { TooltipProvider } = await import("@/shared/ui/tooltip");
const { ChannelTimeline } = await import("./ChannelTimeline.tsx");
const { InboxDetailPane } = await import(
  "@/features/home/ui/InboxDetailPane.tsx"
);

const ME = "1".repeat(64);
const AGENT = "2".repeat(64);
const CHANNEL = "ch-1";

/** Two questions, so the answered card's interview is visibly multi-step. */
function cardPayload(title) {
  return {
    v: 2,
    title,
    questions: [
      {
        id: "scope",
        question: "Which surfaces?",
        options: [
          { id: "web", label: "Web only" },
          { id: "both", label: "Web + desktop" },
        ],
      },
      {
        id: "when",
        question: "When?",
        options: [
          { id: "now", label: "Tonight" },
          { id: "mon", label: "Monday" },
        ],
      },
    ],
  };
}

function cardEvent(id, title, createdAt) {
  const built = buildCardTag(cardPayload(title));
  return {
    id,
    pubkey: AGENT,
    kind: 9,
    created_at: createdAt,
    content: built.fallbackContent,
    tags: [["h", CHANNEL], ...built.tag],
    sig: "0".repeat(128),
  };
}

/**
 * MY complete answer to `cardId` — the event the card must read back. Built
 * through the shipped answer builder, so `done` is DERIVED here exactly as it
 * is on the wire rather than asserted by the fixture.
 */
function answerEvent(id, cardId, createdAt) {
  const card = parseCardTags(
    buildCardTag(cardPayload("Ship the claims fix")).tag,
  );
  assert.ok(card, "the fixture card must parse");
  const built = buildCardAnswerTag(card, cardId, {
    answers: [
      { questionId: "scope", optionIds: ["web"] },
      { questionId: "when", optionIds: ["now"] },
    ],
  });
  assert.equal(built.answer.done, true, "the fixture answer must be complete");
  return {
    id,
    pubkey: ME,
    kind: 9,
    created_at: createdAt,
    content: built.fallbackContent,
    tags: [
      ["h", CHANNEL],
      ["e", cardId, "", "root"],
      ["e", cardId, "", "reply"],
      ["p", AGENT],
      ...built.tag,
    ],
    sig: "0".repeat(128),
  };
}

function messagesFrom(events) {
  return events.map((event) => {
    const message = timelineMessageFromEvent(event);
    assert.ok(message, `event ${event.id} must parse into a timeline message`);
    return message;
  });
}

/**
 * The two shipped hosts, each mounted the way the app mounts it. Named so a
 * failure says WHICH surface lost the wiring.
 */
const HOSTS = {
  "channel timeline": (messages) =>
    React.createElement(ChannelTimeline, {
      messages,
      profiles: new Map(),
      replyCounts: new Map(),
      selfPubkey: ME,
      showActions: false,
    }),
  "inbox detail pane": (messages) =>
    React.createElement(InboxDetailPane, {
      item: {
        conversationId: messages[0].id,
        channelId: CHANNEL,
        channelName: "general",
        channelType: "stream",
        categories: ["mention"],
        message: messages[0],
        messages,
        latestActivityAt: messages[messages.length - 1].createdAt,
        unreadCount: 0,
      },
      context: messages,
      profiles: new Map(),
      selfPubkey: ME,
      isRead: () => true,
      onMarkRead: () => {},
      onMarkUnread: () => {},
      onOpenInChannel: () => {},
      onBack: () => {},
    }),
};

async function mount(messages, host = "channel timeline") {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      // The app mounts its TooltipProvider at the shell; the rows' timestamp
      // tooltips throw without one.
      React.createElement(TooltipProvider, null, HOSTS[host](messages)),
    );
  });
  // Draft restore is an async idb read inside DecisionCard; let it settle so
  // an unanswered card has reached its steady state before we read it.
  await act(async () => {
    await Promise.resolve();
  });
  const row = (messageId) =>
    container.querySelector(`[data-testid="message-row-${messageId}"]`);
  return {
    container,
    row,
    cardCount: () =>
      container.querySelectorAll('[data-testid="decision-card"]').length,
    isTerminal: (messageId) => {
      const node = row(messageId);
      assert.ok(node, `row ${messageId} must be rendered`);
      return node.querySelector('[data-testid="decision-card-sent"]') !== null;
    },
    isAnswerable: (messageId) => {
      const node = row(messageId);
      assert.ok(node, `row ${messageId} must be rendered`);
      return (
        node.querySelector(
          '[data-testid^="card-interview-option-"], [data-testid="card-summary-answer"]',
        ) !== null
      );
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Card answered by me, its answer, and a second card left open. */
function buffer() {
  return messagesFrom([
    cardEvent("card-answered", "Ship the claims fix", 100),
    answerEvent("answer-1", "card-answered", 101),
    cardEvent("card-open", "Pick a release date", 102),
  ]);
}

for (const host of Object.keys(HOSTS)) {
  test(`${host}: the harness renders real rows — both cards mount`, async () => {
    // The count guard. A stub that rendered nothing, or a virtualizer window
    // that resolved to zero items, would make every other assertion in this
    // file vacuously true.
    const view = await mount(buffer(), host);
    assert.equal(view.cardCount(), 2, "both decision cards render");
    assert.ok(view.row("card-answered"), "the answered card has a row");
    assert.ok(view.row("card-open"), "the open card has a row");
    await view.unmount();
  });

  test(`${host}: an answered card renders terminal — the answer reaches it`, async () => {
    // THE WIRING ASSERTION. Cut `cardAnswer=` off this host's MessageRow call
    // and it fails: the card re-arms as an answerable interview with its own
    // answer sitting one row below it.
    const view = await mount(buffer(), host);
    assert.equal(
      view.isTerminal("card-answered"),
      true,
      "the answered card shows the published answer, not the interview",
    );
    assert.equal(
      view.isAnswerable("card-answered"),
      false,
      "and offers nothing to answer a second time",
    );
    await view.unmount();
  });

  test(`${host}: an unanswered card in the same buffer stays answerable`, async () => {
    // The discriminator: without this, a host that marked EVERY card terminal
    // would pass the assertion above.
    const view = await mount(buffer(), host);
    assert.equal(
      view.isTerminal("card-open"),
      false,
      "a card I have not answered is not terminal",
    );
    assert.equal(
      view.isAnswerable("card-open"),
      true,
      "it still offers its options",
    );
    await view.unmount();
  });

  test(`${host}: someone else's answer to the same card leaves it answerable`, async () => {
    // Keys the wiring to MY answer specifically: `answeredCardReplies` is
    // self-scoped, and a host that passed any reply through would clear a
    // card the viewer never answered.
    const foreign = answerEvent("answer-other", "card-answered", 101);
    foreign.pubkey = AGENT;
    const view = await mount(
      messagesFrom([
        cardEvent("card-answered", "Ship the claims fix", 100),
        foreign,
      ]),
      host,
    );
    assert.equal(view.cardCount(), 1, "the card renders");
    assert.equal(
      view.isTerminal("card-answered"),
      false,
      "another viewer's answer is not mine",
    );
    await view.unmount();
  });
}

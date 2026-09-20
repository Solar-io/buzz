import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Reachability, not arithmetic. The parser and the corpus prove the v2 wire
 * format is understood; this proves the SHIPPED component actually reads the
 * normalized shape — a card whose questions never reach a button is a feature
 * that is correct and dead, and no unit test of the parser can see that.
 *
 * Phase 1 renders the FIRST question only, which for a v1 card is the whole
 * card. The stepper that walks the rest is a later phase.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
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
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_RELAY_SESSION__ ?? null, status: "open" };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { parseCardTags } = await import("../lib/decisionCard.ts");
const { DecisionCard } = await import("./DecisionCard.tsx");

function messageWith(payload) {
  const card = parseCardTags([["card", JSON.stringify(payload)]]);
  assert.ok(card, "the fixture payload must parse");
  return {
    id: "card-1",
    kind: 9,
    authorPubkey: "a".repeat(64),
    createdAt: 1,
    content: "fallback",
    card,
    rootId: null,
    replyToId: null,
  };
}

async function mount(payload) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(DecisionCard, { message: messageWith(payload) }),
    );
  });
  return {
    container,
    labels: () =>
      Array.from(
        container.querySelectorAll('[data-testid^="decision-card-option-"]'),
      ).map((node) => node.textContent.trim()),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a v1 card renders its title and every option", async () => {
  const mounted = await mount({
    v: 1,
    title: "Ship the claims fix?",
    body: "Second bounce needed.",
    options: [
      { id: "now", label: "Relaunch now" },
      { label: "Let it ride", recommended: true },
    ],
  });
  const text = mounted.container.textContent;
  assert.ok(text.includes("Ship the claims fix?"), text);
  assert.ok(text.includes("Second bounce needed."), text);
  assert.deepEqual(mounted.labels(), [
    "Relaunch now",
    "Let it rideRecommended",
  ]);
  await mounted.unmount();
});

test("a v2 card renders question one — its text and ITS options", async () => {
  // The discriminating case: the interview title, question two's text and
  // question two's options must all be absent, so reading `questions[0]`
  // cannot be mistaken for reading a flattened option list.
  const mounted = await mount({
    v: 2,
    title: "Release shape",
    questions: [
      {
        question: "Which surfaces?",
        options: [{ label: "Web only" }, { label: "Web + desktop" }],
      },
      {
        question: "When?",
        options: [{ label: "Tonight" }, { label: "Monday" }],
      },
    ],
  });
  const text = mounted.container.textContent;
  assert.ok(text.includes("Which surfaces?"), text);
  assert.ok(!text.includes("When?"), text);
  assert.ok(!text.includes("Release shape"), text);
  assert.deepEqual(mounted.labels(), ["Web only", "Web + desktop"]);
  await mounted.unmount();
});

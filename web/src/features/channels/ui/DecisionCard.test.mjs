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
    // Required by the send path (the `h` tag): without it the reply cannot
    // be signed at all, and the component's catch turns that into an error
    // state rather than a published event.
    channelId: "ch-1",
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
    click: async (testid) => {
      const node = container.querySelector(`[data-testid="${testid}"]`);
      assert.ok(node, `${testid} must exist to be clicked`);
      await act(async () => {
        node.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** A relay session that records what the component actually published. */
function installFakeSession() {
  const calls = [];
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = {
    calls,
    async publish(event) {
      calls.push(event);
      return { ok: true, message: "" };
    },
  };
  return calls;
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

/**
 * Reachability for the ANSWER half. The tag builder having a green suite
 * proves nothing about whether the shipped button calls it — a correct
 * feature nothing invokes is the failure shape no unit test of the library
 * can see. These drive the real component and read the real published event.
 */
test("tapping an option publishes the structured card-answer tag", async () => {
  const calls = installFakeSession();
  const mounted = await mount({
    v: 2,
    title: "Release shape",
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
          { id: "now", label: "Now" },
          { id: "later", label: "Later" },
        ],
      },
    ],
  });

  await mounted.click("decision-card-option-both");

  assert.equal(calls.length, 1);
  const event = calls[0];
  // The machine half, with the OPTION ID — which the plain-text path could
  // never carry, so this assertion cannot pass on the old code path.
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "card-answer"),
    [
      [
        "card-answer",
        '{"v":2,"c":"card-1","a":[{"q":"scope","o":["both"]}],"done":false}',
      ],
    ],
  );
  // The human half. This card shows question one only (the stepper is a
  // later phase), so answering it is a PARTIAL and says so.
  assert.equal(
    event.content,
    [
      "Answered 1 of 2 — the rest are still open.",
      "",
      "**Which surfaces?** — Web + desktop",
      "**When?** — _(not answered)_",
    ].join("\n"),
  );
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "e"),
    [["e", "card-1", "", "reply"]],
  );
  assert.ok(
    mounted.container.textContent.includes("You replied: Web + desktop"),
    mounted.container.textContent,
  );
  await mounted.unmount();
});

test("a typed answer publishes as typed text, not as an option id", async () => {
  const calls = installFakeSession();
  const mounted = await mount({
    v: 1,
    title: "Ship the claims fix?",
    options: [{ id: "now", label: "Relaunch now" }, { label: "Let it ride" }],
  });

  const input = mounted.container.querySelector(
    '[data-testid="decision-card-input"]',
  );
  // The bound is the ANSWER's typed-text limit, not the interview note's.
  assert.equal(input.getAttribute("maxlength"), "200");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "next Tuesday");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await mounted.click("decision-card-send");

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].tags.filter((t) => t[0] === "card-answer"),
    [
      [
        "card-answer",
        '{"v":2,"c":"card-1","a":[{"q":"0","t":"next Tuesday"}],"done":true}',
      ],
    ],
  );
  // A v1 card is one question, so a typed answer COMPLETES it.
  assert.equal(calls[0].content, "**Ship the claims fix?** — next Tuesday");
  await mounted.unmount();
});

test("a card with colliding ids is not a card, so the row renders text", async () => {
  // Duplicate resolved ids are a CONTRACT refusal, not a render fallback:
  // question 1's explicit "1" collides with question 2's positional "1", the
  // parse returns null, and `MessageRow` therefore renders the message's
  // markdown content instead of mounting this component at all. The reply a
  // user then types carries no `card-answer` tag and is COMPLETE by the badge
  // rule — exactly v1's behaviour.
  assert.equal(
    parseCardTags([
      [
        "card",
        JSON.stringify({
          v: 2,
          title: "Collide",
          questions: [
            {
              id: "1",
              question: "First?",
              options: [{ label: "a" }, { label: "b" }],
            },
            { question: "Second?", options: [{ label: "c" }, { label: "d" }] },
          ],
        }),
      ],
    ]),
    null,
  );
  // The component's own contract for that state: given no card it renders
  // nothing, so a null parse can never paint a half-card.
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(DecisionCard, {
        message: {
          id: "card-1",
          channelId: "ch-1",
          kind: 9,
          authorPubkey: "a".repeat(64),
          createdAt: 1,
          content: "fallback",
          card: null,
          rootId: null,
          replyToId: null,
        },
      }),
    );
  });
  assert.equal(container.textContent, "");
  await act(async () => root.unmount());
  container.remove();
});

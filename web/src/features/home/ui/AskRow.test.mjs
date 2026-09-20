import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Reachability. `askInterview.test.mjs` proves the fold; this proves the ROW
 * renders what the fold computed — a chip that is computed and never drawn is
 * the "shipped and dead" shape no library test can see.
 *
 * Every case drives the real component: the multi-question row's Answer
 * button must open the real sheet, and the single-question row must still
 * publish on one tap, because "no regression for v1" is a claim about this
 * file specifically.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
  pretendToBeVisual: true,
});
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
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_RELAY_SESSION__ ?? null, status: "open" };
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
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { parseCardTags } = await import(
  "@/features/channels/lib/decisionCard.ts"
);
const { groupAskInterviews } = await import("../lib/askInterview.ts");
const { AskRow } = await import("./AskRow.tsx");

const AGENT = "2".repeat(64);
const CHANNEL = "ch-1";

function cardOf(payload) {
  const card = parseCardTags([["card", JSON.stringify(payload)]]);
  assert.ok(card, "the fixture payload must parse");
  return card;
}

const TWO_QUESTIONS = {
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
        { id: "now", label: "Tonight" },
        { id: "mon", label: "Monday" },
      ],
    },
  ],
};

const ONE_QUESTION = {
  v: 1,
  title: "Ship the claims fix?",
  options: [
    { id: "yes", label: "Ship it" },
    { id: "no", label: "Hold" },
  ],
};

function ask(id, payload, overrides = {}) {
  return {
    id,
    channelId: CHANNEL,
    channelType: "stream",
    authorPubkey: AGENT,
    createdAt: 100,
    card: cardOf(payload),
    rootId: null,
    replyToId: null,
    ...overrides,
  };
}

function installFakeSession(verdict = { ok: true, message: "" }) {
  const calls = [];
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = {
    calls,
    async publish(event) {
      calls.push(event);
      return verdict;
    },
  };
  return calls;
}

async function mount(interview) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const opened = [];
  await act(async () => {
    root.render(
      React.createElement(AskRow, {
        interview,
        channelLabel: "#general",
        channelType: interview.ask.channelType,
        profiles: new Map(),
        onOpen: () => opened.push(interview.ask.id),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  const find = (testid) =>
    container.querySelector(`[data-testid="${testid}"]`) ??
    dom.window.document.body.querySelector(`[data-testid="${testid}"]`);
  return {
    container,
    opened,
    find,
    text: () => container.textContent,
    click: async (testid) => {
      const node = find(testid);
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

test("a v1 single-question ask keeps its one-tap chips and grows no chips bar", async () => {
  const calls = installFakeSession();
  const [interview] = groupAskInterviews([ask("card-1", ONE_QUESTION)], {});
  const view = await mount(interview);
  assert.ok(view.find("ask-row-answer-card-1-yes"), "the option chip renders");
  assert.equal(
    view.find("ask-row-round-card-1"),
    null,
    "round 1 earns no chip",
  );
  assert.equal(
    view.find("ask-row-progress-card-1"),
    null,
    "one question earns no N/M chip",
  );
  assert.equal(
    view.find("ask-row-open-interview-card-1"),
    null,
    "and no Answer button: one tap IS the answer",
  );
  await view.click("ask-row-answer-card-1-yes");
  assert.equal(calls.length, 1, "one tap published one reply");
  assert.equal(calls[0].content, "Ship it", "the label, verbatim — v1 shape");
  assert.equal(
    calls[0].tags.some((tag) => tag[0] === "card-answer"),
    false,
    "no card-answer tag, which is what makes it complete by the badge rule",
  );
  assert.ok(view.find("ask-row-answered-card-1"), "the row says so");
  await view.unmount();
});

test("a multi-question ask offers the sheet instead of chips", async () => {
  installFakeSession();
  const [interview] = groupAskInterviews([ask("card-1", TWO_QUESTIONS)], {});
  const view = await mount(interview);
  assert.equal(
    view.find("ask-row-answer-card-1-web"),
    null,
    "no one-tap chip can answer two questions",
  );
  assert.ok(view.find("ask-row-open-interview-card-1"), "the Answer button");
  assert.ok(
    view.find("ask-row-progress-card-1"),
    "and the N/M chip, because there is an N and an M",
  );
  assert.match(view.text(), /0\/2/);
  assert.match(view.text(), /2 questions/);
  await view.unmount();
});

test("Round 2 is on the row, and it came from the thread", async () => {
  installFakeSession();
  const rows = groupAskInterviews(
    [
      ask("card-1", TWO_QUESTIONS),
      ask("card-2", TWO_QUESTIONS, {
        createdAt: 300,
        rootId: "card-1",
        replyToId: "answer-1",
      }),
    ],
    { "card-1": "answer-1" },
  );
  assert.equal(rows.length, 1, "one row for the thread");
  const view = await mount(rows[0]);
  const chip = view.find("ask-row-round-card-2");
  assert.ok(chip, "the round chip renders");
  assert.equal(chip.textContent, "Round 2");
  await view.unmount();
});

test("a second open card in the thread shows as +1 earlier, not as a row", async () => {
  installFakeSession();
  const rows = groupAskInterviews(
    [
      ask("card-1", TWO_QUESTIONS),
      ask("card-2", TWO_QUESTIONS, {
        createdAt: 300,
        rootId: "card-1",
        replyToId: "answer-1",
      }),
    ],
    {},
  );
  const view = await mount(rows[0]);
  const earlier = view.find("ask-row-earlier-card-2");
  assert.ok(earlier, "the affordance renders");
  assert.match(earlier.textContent, /\+1 earlier/);
  await view.unmount();
});

test("the inbox answers a whole interview through the sheet, in one reply", async () => {
  // The point of the phase: the inbox is an answering surface, and what it
  // publishes is structurally identical to what the timeline card publishes.
  const calls = installFakeSession();
  const [interview] = groupAskInterviews([ask("card-1", TWO_QUESTIONS)], {});
  const view = await mount(interview);
  await view.click("ask-row-open-interview-card-1");
  assert.ok(view.find("card-interview-sheet"), "the sheet opened");
  await view.click("card-interview-option-web");
  assert.equal(calls.length, 0, "answering question one publishes nothing");
  await view.click("card-interview-option-now");
  assert.equal(calls.length, 1, "the last answer auto-submits, once");
  const event = calls[0];
  const answerTag = event.tags.filter((tag) => tag[0] === "card-answer");
  assert.equal(answerTag.length, 1, "exactly one card-answer tag");
  const payload = JSON.parse(answerTag[0][1]);
  assert.equal(payload.done, true, "two of two answered is complete");
  assert.deepEqual(payload.a, [
    { q: "scope", o: ["web"] },
    { q: "when", o: ["now"] },
  ]);
  assert.equal(
    event.tags.some((tag) => tag[0] === "e" && tag[1] === "card-1"),
    true,
    "the reply marker names the card",
  );
  assert.match(event.content, /\*\*Which surfaces\?\*\* — Web only/);
  await view.unmount();
});

test("a relay refusal keeps the interview answerable, with the verdict verbatim", async () => {
  installFakeSession({ ok: false, message: "blocked: rate limited" });
  const [interview] = groupAskInterviews([ask("card-1", TWO_QUESTIONS)], {});
  const view = await mount(interview);
  await view.click("ask-row-open-interview-card-1");
  await view.click("card-interview-option-web");
  await view.click("card-interview-option-now");
  const error = view.find("ask-row-error-card-1");
  assert.ok(error, "the refusal is surfaced");
  assert.match(error.textContent, /blocked: rate limited/);
  assert.equal(
    view.find("ask-row-answered-card-1"),
    null,
    "and nothing claims the ask was answered",
  );
  await view.unmount();
});

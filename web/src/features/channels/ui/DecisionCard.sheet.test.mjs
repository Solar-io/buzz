import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The redesigned card chrome (web redesign Phase 2; Message and PhoneAsk
 * artboards), driven through the SHIPPED component: the header bar that
 * carries the title once, the answered pill, and the phone sheet's asker,
 * previous-answer Edit, Next-on-revisit and "Not now, send to Feedback".
 *
 * `DecisionCard.test.mjs` owns the answering contract and is at the file-size
 * ceiling, so this is a sibling with the same harness rather than more of it.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Radix reaches for these off globalThis, and Node's own Event classes cannot
// be dispatched on a jsdom node — see DecisionCard.test.mjs for the long form.
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
      // A non-configurable Node global we must not (and need not) shadow.
    }
  }
}
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
  // The shell's reminders handle, recording what the sheet files.
  "@/features/reminders/ui/RemindMeLaterProvider": `
    export function useRemindMeLater() {
      return globalThis.__BUZZ_TEST_REMINDERS__ ?? {
        available: false,
        sendToFeedback() {},
        feedbackPending: false,
        pendingEventIds: new Set(),
      };
    }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { parseCardTags } = await import("../lib/decisionCard.ts");
const { timelineMessageFromEvent } = await import("../lib/messageBuffer.ts");
const { DecisionCard } = await import("./DecisionCard.tsx");

const ASKER = { pubkey: "a".repeat(64), label: "Gilfoyle" };

const THREE = {
  v: 2,
  title: "XiaoZhi setup",
  questions: [
    {
      id: "lang",
      header: "Language",
      question: "Which language?",
      options: [
        { id: "en", label: "English" },
        { id: "zh", label: "Mandarin" },
      ],
    },
    {
      id: "wake",
      question: "Which wake word should XiaoZhi listen for?",
      options: [
        { id: "buzz", label: "Hey Buzz", recommended: true },
        { id: "stock", label: "Hi XiaoZhi" },
      ],
    },
    {
      id: "vol",
      question: "Speaker volume?",
      options: [
        { id: "lo", label: "Low" },
        { id: "hi", label: "High" },
      ],
    },
  ],
};

function messageWith(payload, id) {
  const card = parseCardTags([["card", JSON.stringify(payload)]]);
  assert.ok(card, "the fixture payload must parse");
  return {
    id,
    channelId: "ch-1",
    kind: 9,
    authorPubkey: ASKER.pubkey,
    createdAt: 1,
    content: "fallback",
    card,
    rootId: null,
    replyToId: null,
  };
}

// DOM nodes are compared as booleans: an assert.equal(node, null) that FAILS
// util.inspects a jsdom element, which takes minutes and reads as a hang.
async function mount(payload, { id, answer = null, asker = ASKER } = {}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(DecisionCard, {
        message: messageWith(payload, id),
        answer,
        asker,
      }),
    );
  });
  const find = (testid) => container.querySelector(`[data-testid="${testid}"]`);
  const sheet = () =>
    dom.window.document.body.querySelector(
      '[data-testid="card-interview-sheet"]',
    );
  const clickNode = async (node) => {
    await act(async () => {
      node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  return {
    container,
    find,
    sheet,
    inSheet: (testid) => sheet()?.querySelector(`[data-testid="${testid}"]`),
    click: async (testid) => {
      const node = find(testid);
      assert.ok(node, `${testid} must exist to be clicked`);
      await clickNode(node);
    },
    clickInSheet: async (testid) => {
      const node = sheet()?.querySelector(`[data-testid="${testid}"]`);
      assert.ok(node, `${testid} must exist inside the sheet`);
      await clickNode(node);
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function installFakeSession() {
  const calls = [];
  globalThis.__BUZZ_TEST_RELAY_SESSION__ = {
    async publish(event) {
      calls.push(event);
      return { ok: true, message: "" };
    },
  };
  return calls;
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

/** What a sighted reader sees: the text minus screen-reader-only labels. */
function visibleText(container) {
  const copy = container.cloneNode(true);
  for (const node of copy.querySelectorAll(".sr-only")) {
    node.remove();
  }
  return copy.textContent;
}

test("a v1 card says its question once: in the header, not again in the body", async () => {
  globalThis.__BUZZ_TEST_IDB__.data.clear();
  const mounted = await mount(
    {
      v: 1,
      title: "Ship the claims fix?",
      options: [
        { id: "now", label: "Relaunch now" },
        { id: "ride", label: "Let it ride" },
      ],
    },
    { id: "card-v1-once" },
  );
  // jsdom renders BOTH the desktop stepper and the phone tile (the split is
  // CSS), so a repeat in either would count here.
  const text = visibleText(mounted.container);
  assert.equal(occurrences(text, "Ship the claims fix?"), 1, text);
  await mounted.unmount();
});

test("a v2 card keeps its title in the header AND each question in the body", async () => {
  globalThis.__BUZZ_TEST_IDB__.data.clear();
  const mounted = await mount(THREE, { id: "card-v2-heading" });
  const text = visibleText(mounted.container);
  assert.equal(occurrences(text, "XiaoZhi setup"), 1, text);
  assert.equal(occurrences(text, "Which language?"), 1, text);
  await mounted.unmount();
});

test("the sheet names the asker, offers the last answer for Edit, and Next moves on without re-answering", async () => {
  globalThis.__BUZZ_TEST_IDB__.data.clear();
  const calls = installFakeSession();
  const mounted = await mount(THREE, { id: "card-sheet-next" });
  await mounted.click("card-summary-answer");
  const header = mounted.sheet().textContent;
  assert.ok(header.includes("Gilfoyle asks"), header);
  assert.ok(header.includes("XiaoZhi setup"), header);
  // Question one: nothing answered yet, so no previous chip and no Next —
  // tapping an option IS the next step.
  assert.ok(!mounted.inSheet("card-interview-previous"), "no previous chip");
  assert.ok(!mounted.inSheet("card-interview-next"), "no Next on Q1");

  await mounted.clickInSheet("card-interview-option-en");
  const previous = mounted.inSheet("card-interview-previous");
  assert.ok(previous, "the answer just given is one tap from Edit");
  assert.ok(previous.textContent.includes("Language"), previous.textContent);
  assert.ok(previous.textContent.includes("English"), previous.textContent);

  await mounted.clickInSheet("card-interview-previous");
  assert.ok(mounted.sheet().textContent.includes("Which language?"));
  const next = mounted.inSheet("card-interview-next");
  assert.ok(next, "a revisited answered question offers Next");
  assert.ok(next.textContent.includes("English"), next.textContent);
  await mounted.clickInSheet("card-interview-next");
  assert.ok(
    mounted.sheet().textContent.includes("Which wake word"),
    "Next advances to the following question",
  );
  assert.equal(calls.length, 0, "moving through the sheet publishes nothing");
  await mounted.unmount();
});

test("Not now, send to Feedback files the ask, closes the sheet and answers nothing", async () => {
  globalThis.__BUZZ_TEST_IDB__.data.clear();
  const calls = installFakeSession();
  const filed = [];
  globalThis.__BUZZ_TEST_REMINDERS__ = {
    available: true,
    sendToFeedback: (target) => filed.push(target),
    feedbackPending: false,
    pendingEventIds: new Set(),
  };
  try {
    const mounted = await mount(THREE, { id: "card-sheet-feedback" });
    await mounted.click("card-summary-answer");
    await mounted.clickInSheet("card-interview-option-zh");
    await mounted.clickInSheet("card-interview-feedback");
    assert.ok(!mounted.sheet(), "filing closes the sheet");
    assert.equal(filed.length, 1);
    assert.equal(filed[0].eventId, "card-sheet-feedback");
    assert.equal(filed[0].channelId, "ch-1");
    assert.equal(filed[0].preview, "XiaoZhi setup");
    assert.equal(calls.length, 0, "Feedback is not an answer");
    assert.equal(
      mounted.find("card-summary-answer").textContent,
      "Resume — 1 of 3",
      "the draft survives filing",
    );
    await mounted.unmount();
  } finally {
    globalThis.__BUZZ_TEST_REMINDERS__ = undefined;
  }
});

test("without a reminders provider the sheet offers no Feedback button", async () => {
  globalThis.__BUZZ_TEST_IDB__.data.clear();
  const mounted = await mount(THREE, { id: "card-sheet-no-feedback" });
  await mounted.click("card-summary-answer");
  assert.ok(mounted.sheet());
  assert.ok(!mounted.inSheet("card-interview-feedback"), "no Feedback button");
  await mounted.unmount();
});

test("an answered card wears an Answered pill with the answer's time", async () => {
  globalThis.__BUZZ_TEST_IDB__.data.clear();
  const calls = installFakeSession();
  const first = await mount(THREE, { id: "card-answered-pill" });
  assert.ok(!first.find("decision-card-answered"), "open: no pill");
  await first.click("card-interview-option-en");
  await first.click("card-interview-option-buzz");
  await first.click("card-interview-option-lo");
  assert.equal(calls.length, 1);
  await first.unmount();

  const published = timelineMessageFromEvent(calls[0]);
  assert.ok(published);
  const remounted = await mount(THREE, {
    id: "card-answered-pill",
    answer: published,
  });
  const pill = remounted.find("decision-card-answered");
  assert.ok(pill, remounted.container.textContent);
  assert.match(pill.textContent, /^Answered \S/);
  assert.ok(remounted.find("decision-card-sent"));
  await remounted.unmount();
});

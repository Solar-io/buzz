import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Reachability, not arithmetic. `cardInterview.test.mjs` proves the
 * sequencing rules; the corpus proves the wire format. This file proves the
 * SHIPPED component actually invokes them — a stepper that is correct and
 * that nothing calls is the failure shape no library test can see, and the
 * card shipped once already as "complete and tested" while rendering only
 * question one.
 *
 * So every case here drives the real component through real clicks and reads
 * the event it really published.
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

globalThis.__BUZZ_TEST_IDB__ = { data: new Map() };

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_RELAY_SESSION__ ?? null, status: "open" };
    }
    export function RelaySessionProvider({ children }) { return children ?? null; }
  `,
  // An in-memory IndexedDB, so draft persistence is OBSERVABLE here rather
  // than silently swallowed by the real idb-keyval throwing under node.
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
const { parseCardTags } = await import("../lib/decisionCard.ts");
const { cardDraftKey } = await import("../lib/cardDraft.ts");
const { timelineMessageFromEvent } = await import("../lib/messageBuffer.ts");
const { DecisionCard } = await import("./DecisionCard.tsx");

const idb = globalThis.__BUZZ_TEST_IDB__;

function messageWith(payload, id = "card-1") {
  const card = parseCardTags([["card", JSON.stringify(payload)]]);
  assert.ok(card, "the fixture payload must parse");
  return {
    id,
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

async function mount(payload, { id = "card-1", onAnswerInChat, answer } = {}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(DecisionCard, {
        message: messageWith(payload, id),
        answer,
        onAnswerInChat,
      }),
    );
  });
  const find = (testid) => container.querySelector(`[data-testid="${testid}"]`);
  return {
    container,
    find,
    text: () => container.textContent,
    labels: () =>
      Array.from(
        container.querySelectorAll('[data-testid^="card-interview-option-"]'),
      ).map((node) => node.textContent.trim()),
    click: async (testid) => {
      const node = find(testid);
      assert.ok(node, `${testid} must exist to be clicked`);
      await act(async () => {
        node.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
    },
    type: async (testid, value) => {
      const node = find(testid);
      assert.ok(node, `${testid} must exist to type into`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(node, value);
        node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** A relay session that records what the component actually published. */
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

function answerTag(event) {
  const tags = event.tags.filter((tag) => tag[0] === "card-answer");
  assert.equal(tags.length, 1, "exactly one card-answer tag");
  return JSON.parse(tags[0][1]);
}

/** Four questions: single, multi, single, single. */
const FOUR = {
  v: 2,
  title: "Release shape",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which surfaces?",
      options: [
        { id: "web", label: "Web only" },
        { id: "both", label: "Web + desktop" },
      ],
    },
    {
      id: "extras",
      question: "Which extras?",
      multiSelect: true,
      options: [
        { id: "docs", label: "Docs" },
        { id: "tests", label: "Tests" },
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
    {
      id: "who",
      question: "Who reviews?",
      options: [
        { id: "sam", label: "Sam" },
        { id: "nobody", label: "Nobody" },
      ],
    },
  ],
};

test("a v1 card renders its question and every option", async () => {
  idb.data.clear();
  const mounted = await mount({
    v: 1,
    title: "Ship the claims fix?",
    body: "Second bounce needed.",
    options: [
      { id: "now", label: "Relaunch now" },
      { label: "Let it ride", recommended: true },
    ],
  });
  const text = mounted.text();
  assert.ok(text.includes("Ship the claims fix?"), text);
  assert.ok(text.includes("Second bounce needed."), text);
  assert.deepEqual(mounted.labels(), [
    "Relaunch now",
    "Let it rideRecommended",
  ]);
  // One question means no progress rail and no back chevron — the v1 card,
  // unchanged, reached through the interview path.
  assert.equal(mounted.find("card-interview-progress"), null);
  assert.equal(mounted.find("card-interview-back"), null);
  await mounted.unmount();
});

test("a v2 card shows question one, with progress for the set", async () => {
  idb.data.clear();
  const mounted = await mount(FOUR);
  const text = mounted.text();
  assert.ok(text.includes("Which surfaces?"), text);
  assert.ok(text.includes("Release shape"), text);
  assert.ok(!text.includes("When?"), text);
  assert.deepEqual(mounted.labels(), ["Web only", "Web + desktop"]);
  assert.equal(
    mounted.find("card-interview-progress").textContent,
    "Question 1 of 4",
  );
  // One segment per question — a rail that drew the wrong number would be
  // invisible to a count-free assertion.
  assert.equal(
    mounted.container.querySelectorAll('[data-testid^="card-interview-step-"]')
      .length,
    4,
  );
  await mounted.unmount();
});

test("answering four questions publishes ONE reply carrying all four", async () => {
  // The whole of Phase 3 in one case: four answers, four lines, one event,
  // `done:true`, and no publish before the last tap. Every intermediate
  // assertion on `calls.length` is what makes "nothing publishes until
  // submit" a measured fact rather than a design note.
  idb.data.clear();
  const calls = installFakeSession();
  const mounted = await mount(FOUR);

  await mounted.click("card-interview-option-web");
  assert.equal(calls.length, 0, "answering question 1 publishes nothing");
  assert.equal(
    mounted.find("card-interview-progress").textContent,
    "Question 2 of 4 · 1 answered",
  );
  assert.ok(mounted.text().includes("Which extras?"), mounted.text());

  // Multi-select: two ticks, then Continue. A tick must not advance.
  await mounted.click("card-interview-option-tests");
  assert.ok(
    mounted.text().includes("Which extras?"),
    "a tick must not advance",
  );
  await mounted.click("card-interview-option-docs");
  assert.equal(calls.length, 0);
  await mounted.click("card-interview-continue");
  assert.ok(mounted.text().includes("When?"), mounted.text());

  await mounted.click("card-interview-option-mon");
  assert.equal(calls.length, 0, "three of four is still a draft");
  assert.ok(mounted.text().includes("Who reviews?"), mounted.text());

  // The last question auto-submits — no terminal confirm tap.
  await mounted.click("card-interview-option-sam");
  assert.equal(calls.length, 1, "exactly one event for the whole interview");

  const event = calls[0];
  assert.deepEqual(answerTag(event), {
    v: 2,
    c: "card-1",
    a: [
      { q: "scope", o: ["web"] },
      // Ticked tests first, docs second — the payload is in CARD order.
      { q: "extras", o: ["docs", "tests"] },
      { q: "when", o: ["mon"] },
      { q: "who", o: ["sam"] },
    ],
    done: true,
  });
  assert.equal(
    event.content,
    [
      "**Which surfaces?** — Web only",
      "**Which extras?** — Docs, Tests",
      "**When?** — Monday",
      "**Who reviews?** — Sam",
    ].join("\n"),
  );
  assert.deepEqual(
    event.tags.filter((tag) => tag[0] === "e"),
    [["e", "card-1", "", "reply"]],
  );
  assert.ok(
    mounted.find("decision-card-sent"),
    "a complete answer is terminal",
  );
  assert.ok(
    mounted.text().includes("Web only · Docs, Tests · Monday · Sam"),
    mounted.text(),
  );
  // A completed interview deletes its draft: nothing to resume.
  assert.equal(idb.data.has(cardDraftKey("card-1")), false);
  await mounted.unmount();
});

test("an answered card is terminal on a REMOUNT, from the answer event", async () => {
  // THE regression this seeding exists for, and the reload is not the worst
  // half of it: the timeline is a virtua virtualizer, so scrolling an
  // answered card out of the window and back UNMOUNTS and remounts it. Before
  // the fix that card came back at "Question 1 of 4" with live options and
  // would happily publish a SECOND done:true answer to a card the agent had
  // already acted on — measured live 2026-09-20, no reload involved.
  //
  // So the remount here is the real one (unmount + fresh mount, no shared
  // state), and the answer handed to it is the event the FIRST mount really
  // published, parsed by the shipped `timelineMessageFromEvent`.
  idb.data.clear();
  const calls = installFakeSession();
  const first = await mount(FOUR, { id: "card-remount" });
  await first.click("card-interview-option-both");
  await first.click("card-interview-option-tests");
  await first.click("card-interview-continue");
  await first.click("card-interview-option-now");
  await first.click("card-interview-option-sam");
  assert.equal(calls.length, 1, "the interview published exactly one answer");
  await first.unmount();

  const published = timelineMessageFromEvent(calls[0]);
  assert.ok(published, "the published answer must parse as a timeline row");
  assert.equal(published.replyToId, "card-remount");
  assert.equal(published.cardAnswer?.done, true);

  const remounted = await mount(FOUR, {
    id: "card-remount",
    answer: published,
  });
  assert.ok(
    remounted.find("decision-card-sent"),
    `a remounted answered card must be terminal; rendered: ${remounted.text()}`,
  );
  // Terminal means the interview is GONE, not merely captioned: no options,
  // no progress rail, nothing to tap.
  assert.deepEqual(remounted.labels(), []);
  assert.equal(remounted.find("card-interview-progress"), null);
  assert.equal(remounted.find("card-interview-send-partial"), null);
  // And the summary is rebuilt from the tag's option IDS against the card's
  // labels — the values differ from the previous test's, so a summary copied
  // from anywhere else reads wrong.
  assert.ok(
    remounted.text().includes("Web + desktop · Tests · Tonight · Sam"),
    remounted.text(),
  );
  // Nothing more was published by the remount.
  assert.equal(calls.length, 1);
  await remounted.unmount();
});

test("an UNANSWERED card of the same shape still renders the stepper", async () => {
  // The other side of the discriminating pair: identical card, identical
  // mount, no answer event. If this rendered terminal too, the test above
  // would be proving nothing.
  idb.data.clear();
  installFakeSession();
  const mounted = await mount(FOUR, { id: "card-remount" });
  assert.equal(mounted.find("decision-card-sent"), null);
  assert.deepEqual(mounted.labels(), ["Web only", "Web + desktop"]);
  await mounted.unmount();
});

test("a v1 plain answer makes a v1 card terminal on remount too", async () => {
  // One path for both versions: a reply with NO card-answer tag is complete
  // (v1, AskRow chips, dismiss-and-type-freely), and its content IS the
  // chosen label, so that is what "You replied" shows.
  idb.data.clear();
  installFakeSession();
  const mounted = await mount(
    {
      v: 1,
      title: "Ship the claims fix?",
      options: [{ id: "now", label: "Relaunch now" }, { label: "Let it ride" }],
    },
    {
      id: "card-v1",
      answer: {
        id: "answer-v1",
        channelId: "ch-1",
        kind: 9,
        authorPubkey: "a".repeat(64),
        createdAt: 2,
        content: "Relaunch now",
        card: null,
        cardAnswer: null,
        rootId: null,
        replyToId: "card-v1",
      },
    },
  );
  assert.ok(mounted.find("decision-card-sent"), mounted.text());
  assert.ok(
    mounted.text().includes("You replied: Relaunch now"),
    mounted.text(),
  );
  assert.deepEqual(mounted.labels(), []);
  await mounted.unmount();
});

test("a terminal card drops its draft rather than leaving one to resume", async () => {
  // The card was half-answered on this device and finished somewhere else.
  // The stale draft must not survive the answer it was superseded by.
  idb.data.clear();
  installFakeSession();
  idb.data.set(cardDraftKey("card-elsewhere"), {
    v: "v1",
    cardId: "card-elsewhere",
    index: 1,
    answers: { scope: { optionIds: ["web"] } },
    note: "",
    at: Date.now(),
  });
  const mounted = await mount(FOUR, {
    id: "card-elsewhere",
    answer: {
      id: "answer-elsewhere",
      channelId: "ch-1",
      kind: 9,
      authorPubkey: "a".repeat(64),
      createdAt: 5,
      content: "**Which surfaces?** — Web only",
      card: null,
      cardAnswer: {
        v: 2,
        cardId: "card-elsewhere",
        answers: [
          { questionId: "scope", optionIds: ["web"] },
          { questionId: "extras", optionIds: ["docs"] },
          { questionId: "when", optionIds: ["mon"] },
          { questionId: "who", optionIds: ["sam"] },
        ],
        done: true,
      },
      rootId: null,
      replyToId: "card-elsewhere",
    },
  });
  assert.ok(mounted.find("decision-card-sent"), mounted.text());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idb.data.has(cardDraftKey("card-elsewhere")), false);
  await mounted.unmount();
});

test("Send what I have publishes done:false and stays answerable", async () => {
  idb.data.clear();
  const calls = installFakeSession();
  const mounted = await mount(FOUR);
  await mounted.click("card-interview-option-both");
  await mounted.click("card-interview-option-docs");
  await mounted.click("card-interview-continue");

  const partial = mounted.find("card-interview-send-partial");
  assert.ok(partial, "a partial must offer the escape hatch");
  assert.equal(partial.textContent, "Send what I have (2 of 4)");
  await mounted.click("card-interview-send-partial");

  assert.equal(calls.length, 1);
  const payload = answerTag(calls[0]);
  assert.equal(payload.done, false);
  assert.deepEqual(payload.a, [
    { q: "scope", o: ["both"] },
    { q: "extras", o: ["docs"] },
  ]);
  assert.equal(
    calls[0].content.split("\n")[0],
    "Answered 2 of 4 — the rest are still open.",
  );
  // NOT terminal: the ask stays lit, so the card must stay answerable.
  assert.equal(mounted.find("decision-card-sent"), null);
  assert.ok(mounted.find("card-interview-option-now"), "question 3 still open");
  assert.ok(
    mounted.text().includes("Sent 2 of 4 — the rest are still open."),
    mounted.text(),
  );
  await mounted.unmount();
});

test("completing a partial publishes a SECOND answer with done:true", async () => {
  idb.data.clear();
  const calls = installFakeSession();
  const mounted = await mount(FOUR);
  await mounted.click("card-interview-option-web");
  await mounted.click("card-interview-option-docs");
  await mounted.click("card-interview-continue");
  await mounted.click("card-interview-send-partial");
  assert.equal(calls.length, 1);
  assert.equal(answerTag(calls[0]).done, false);

  await mounted.click("card-interview-option-now");
  await mounted.click("card-interview-option-nobody");
  assert.equal(calls.length, 2, "the completion is a second event");
  const second = answerTag(calls[1]);
  assert.equal(second.done, true);
  assert.equal(second.a.length, 4);
  await mounted.unmount();
});

test("a typed answer rides as text and advances like a tap", async () => {
  idb.data.clear();
  const calls = installFakeSession();
  const mounted = await mount(FOUR);
  await mounted.click("card-interview-something-else");
  const input = mounted.find("card-interview-input");
  // The bound is the ANSWER's typed-text limit (200), not the note's (2000).
  assert.equal(input.getAttribute("maxlength"), "200");
  await mounted.type("card-interview-input", "only the iOS shell");
  await mounted.click("card-interview-send-typed");
  assert.equal(calls.length, 0, "a typed answer publishes nothing either");
  assert.ok(mounted.text().includes("Which extras?"), mounted.text());
  // And the box closes for the new question rather than carrying text over.
  assert.equal(mounted.find("card-interview-input"), null);

  await mounted.click("card-interview-option-tests");
  await mounted.click("card-interview-continue");
  await mounted.click("card-interview-option-now");
  await mounted.click("card-interview-option-sam");
  assert.equal(calls.length, 1);
  assert.deepEqual(answerTag(calls[0]).a[0], {
    q: "scope",
    t: "only the iOS shell",
  });
  assert.equal(
    calls[0].content.split("\n")[0],
    "**Which surfaces?** — only the iOS shell",
  );
  await mounted.unmount();
});

test("the interview note rides in the tag and the content", async () => {
  idb.data.clear();
  const calls = installFakeSession();
  const mounted = await mount(FOUR);
  await mounted.click("card-interview-option-web");
  await mounted.click("card-interview-option-docs");
  await mounted.click("card-interview-continue");
  await mounted.click("card-interview-option-now");
  // The note is offered on the LAST question only.
  assert.ok(mounted.find("card-interview-note"), "note input on question 4");
  assert.equal(
    mounted.find("card-interview-note").getAttribute("maxlength"),
    "2000",
  );
  await mounted.type("card-interview-note", "keep the CLI unchanged");
  await mounted.click("card-interview-option-sam");
  assert.equal(calls.length, 1);
  assert.equal(answerTag(calls[0]).n, "keep the CLI unchanged");
  assert.ok(
    calls[0].content.endsWith("_Note: keep the CLI unchanged_"),
    calls[0].content,
  );
  await mounted.unmount();
});

test("a half-answered interview is written to the draft store", async () => {
  idb.data.clear();
  installFakeSession();
  const mounted = await mount(FOUR, { id: "card-draft-1" });
  await mounted.click("card-interview-option-both");
  // The write is debounced; unmount flushes it, which is the case that
  // matters — the virtualizer unmounts a card that scrolls away.
  await mounted.unmount();
  await new Promise((resolve) => setImmediate(resolve));
  const stored = idb.data.get(cardDraftKey("card-draft-1"));
  assert.ok(stored, "a partial interview must survive the unmount");
  assert.deepEqual(stored.answers.scope, { optionIds: ["both"] });
});

test("a stored draft resumes at the first unanswered question", async () => {
  // The unit analogue of the live reload gate: 2 of 4 stored, so the card
  // paints question THREE. Question 3 is the discriminating value — a
  // restore that ignored the draft would show question 1, and one that
  // restored the stored index would show question 4.
  idb.data.clear();
  installFakeSession();
  idb.data.set(cardDraftKey("card-resume"), {
    v: "v1",
    cardId: "card-resume",
    index: 3,
    answers: {
      scope: { optionIds: ["both"] },
      extras: { optionIds: ["docs", "tests"] },
    },
    note: "half done",
    at: Date.now(),
  });
  const mounted = await mount(FOUR, { id: "card-resume" });
  assert.equal(
    mounted.find("card-interview-progress").textContent,
    "Question 3 of 4 · 2 answered",
  );
  assert.ok(mounted.text().includes("When?"), mounted.text());
  assert.deepEqual(mounted.labels(), ["Tonight", "Monday"]);
  // And the restored answers really are the ones that get published.
  const calls = installFakeSession();
  await mounted.click("card-interview-option-now");
  await mounted.click("card-interview-option-sam");
  assert.equal(calls.length, 1);
  const payload = answerTag(calls[0]);
  assert.equal(payload.done, true);
  assert.deepEqual(payload.a[0], { q: "scope", o: ["both"] });
  assert.deepEqual(payload.a[1], { q: "extras", o: ["docs", "tests"] });
  assert.equal(payload.n, "half done");
  await mounted.unmount();
});

test("the progress segments jump back to an answered question", async () => {
  idb.data.clear();
  installFakeSession();
  const mounted = await mount(FOUR);
  await mounted.click("card-interview-option-web");
  assert.ok(mounted.text().includes("Which extras?"));
  await mounted.click("card-interview-step-0");
  assert.ok(mounted.text().includes("Which surfaces?"), mounted.text());
  assert.equal(
    mounted.find("card-interview-step-0").getAttribute("aria-label"),
    "Question 1, answered: Web only",
  );
  assert.equal(
    mounted.find("card-interview-step-2").getAttribute("aria-label"),
    "Question 3, not answered",
  );
  // The back chevron is the other route, and only exists past question one.
  await mounted.click("card-interview-option-both");
  await mounted.click("card-interview-back");
  assert.ok(mounted.text().includes("Which surfaces?"), mounted.text());
  await mounted.unmount();
});

test("a relay refusal keeps the card answerable, with the verdict verbatim", async () => {
  // publish() RESOLVES {ok:false}; a component that read resolution as
  // success would paint "You replied" over a message that never landed.
  idb.data.clear();
  installFakeSession({ ok: false, message: "invalid: rate limited" });
  const mounted = await mount({
    v: 1,
    title: "Ship it?",
    options: [{ id: "yes", label: "Yes" }, { label: "No" }],
  });
  await mounted.click("card-interview-option-yes");
  assert.equal(mounted.find("decision-card-sent"), null);
  assert.ok(
    mounted
      .find("decision-card-error")
      .textContent.includes("invalid: rate limited"),
    mounted.find("decision-card-error").textContent,
  );
  // Still answerable, and the answer is still held.
  assert.ok(mounted.find("card-interview-option-yes"));
  await mounted.unmount();
});

test("Answer in chat instead hands the card back to the host", async () => {
  idb.data.clear();
  installFakeSession();
  let opened = 0;
  const mounted = await mount(FOUR, { onAnswerInChat: () => (opened += 1) });
  await mounted.click("card-interview-answer-in-chat");
  assert.equal(opened, 1);
  await mounted.unmount();

  // Without the callback the link is absent, not dead: a flat thread pane
  // has no "open the thread on this card" navigation to offer.
  const flat = await mount(FOUR);
  assert.equal(flat.find("card-interview-answer-in-chat"), null);
  await flat.unmount();
});

test("author text is bidi-isolated, so a label cannot reorder the card", async () => {
  // Phase 1 deliberately lets RTL overrides and zero-width joiners ride the
  // wire verbatim and defers the answer to the render phase. This is that
  // answer: every author string is inside a <bdi>, whose default
  // `unicode-bidi: isolate` closes the directional run at its own boundary.
  idb.data.clear();
  installFakeSession();
  const hostile = "‮elbat detrevni‬";
  const mounted = await mount({
    v: 2,
    title: `Title ${hostile}`,
    questions: [
      {
        id: "q",
        question: `Question ${hostile}`,
        body: `Body ${hostile}`,
        options: [
          {
            id: "a",
            label: `Label ${hostile}`,
            description: `Desc ${hostile}`,
          },
          { id: "b", label: "Plain" },
        ],
      },
      {
        id: "q2",
        question: "Second?",
        options: [{ label: "x" }, { label: "y" }],
      },
    ],
  });
  const isolated = Array.from(mounted.container.querySelectorAll("bdi")).map(
    (node) => node.textContent,
  );
  for (const authored of [
    `Title ${hostile}`,
    `Question ${hostile}`,
    `Body ${hostile}`,
    `Label ${hostile}`,
    `Desc ${hostile}`,
  ]) {
    assert.ok(
      isolated.includes(authored),
      `${JSON.stringify(authored)} must render inside a <bdi>; got ${JSON.stringify(isolated)}`,
    );
  }
  // The override rides through verbatim — isolation is not sanitisation, and
  // rewriting an author's text is the thing the format refused to do.
  assert.ok(mounted.text().includes(hostile));
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

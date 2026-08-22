import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const START = "2026-06-18T00:00:00.000Z";

function step(id, overrides = {}) {
  return {
    id,
    type: "tool",
    renderClass: "shell",
    descriptor: {
      renderClass: "shell",
      label: "Ran command",
      preview: id,
      source: "shell",
      groupKey: "shell:command",
    },
    title: id,
    toolName: "shell",
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "ok",
    isError: false,
    timestamp: START,
    startedAt: START,
    completedAt: "2026-06-18T00:00:01.000Z",
    turnId: "turn-1",
    sessionId: "sess-1",
    channelId: "chan-1",
    ...overrides,
  };
}

async function renderCard(items) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { AgentSessionToolRunCard } = await import(
    "./AgentSessionToolRunCard.tsx"
  );

  const element = (runItems) =>
    createElement(AgentSessionToolRunCard, {
      agentAvatarUrl: null,
      agentName: "Agent",
      agentPubkey: "pk",
      run: {
        id: `tool-run:${runItems[0].id}`,
        items: runItems,
        timestamp: runItems[0].timestamp,
      },
    });

  const view = render(element(items));
  return {
    ...view,
    card: () => view.container.querySelector("details"),
    // Re-render the SAME card id with more/updated steps, exactly as the
    // transcript does while a run streams.
    stream: (nextItems) => view.rerender(element(nextItems)),
  };
}

// ── Disclosure ───────────────────────────────────────────────────────────────

test("a live run is expanded so the reader watches work happen", async () => {
  const { card } = await renderCard([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);
  assert.equal(card().open, true);
});

// The regression this guards: `<details>` fires `toggle` for programmatic
// `open` changes too. If the card's own auto-expand were mistaken for a reader
// choice, the completed run would stay pinned open forever.
test("a run that completes collapses itself without the reader touching it", async () => {
  const { card, stream } = await renderCard([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);
  assert.equal(card().open, true);

  stream([step("a"), step("b")]);
  assert.equal(card().open, false);
});

// Real browsers fire `toggle` for programmatic `open` changes too, so the
// card's own auto-expand arrives back as an event that AGREES with the state we
// just rendered. jsdom does not emit that echo, so it is injected here: without
// the guard the echo is recorded as a reader choice and pins the card open, and
// the completed run never collapses.
test("a browser toggle echo of the card's own auto-expand is not a reader choice", async () => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { card, stream } = await renderCard([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);
  assert.equal(card().open, true);

  // The echo: open state already matches what we rendered.
  await act(async () => {
    fireEvent(card(), new dom.window.Event("toggle"));
  });

  stream([step("a"), step("b")]);
  assert.equal(card().open, false);
});

test("a completed run that contains a failure stays open", async () => {
  const { card, stream } = await renderCard([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);

  stream([step("a"), step("b", { isError: true, status: "failed" })]);
  assert.equal(card().open, true);
});

test("a settled clean run renders collapsed from the start", async () => {
  const { card } = await renderCard([step("a"), step("b")]);
  assert.equal(card().open, false);
});

test("the reader's collapse survives later streaming updates", async () => {
  const { card, stream } = await renderCard([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);
  assert.equal(card().open, true);

  const { act, fireEvent } = await import("@testing-library/react");
  // Reader collapses a live run: emulate the click plus the browser's own
  // open-state mutation, which is what actually fires `toggle`.
  await act(async () => {
    card().open = false;
    fireEvent(card(), new dom.window.Event("toggle"));
  });
  assert.equal(card().open, false);

  // A new step arrives; the reader's choice still wins over "live means open".
  stream([
    step("a"),
    step("b"),
    step("c", { status: "executing", completedAt: null }),
  ]);
  assert.equal(card().open, false);
});

test("the reader can open a failed run's card and keep it open", async () => {
  const { card, stream } = await renderCard([
    step("a", { isError: true, status: "failed" }),
    step("b"),
  ]);
  assert.equal(card().open, true);

  const { act, fireEvent } = await import("@testing-library/react");
  await act(async () => {
    card().open = false;
    fireEvent(card(), new dom.window.Event("toggle"));
  });
  assert.equal(card().open, false);

  stream([step("a", { isError: true, status: "failed" }), step("b")]);
  assert.equal(card().open, false);
});

// ── Header ───────────────────────────────────────────────────────────────────

test("the header reads as an outcome once settled and names the failing count", async () => {
  const { container, getByText } = await renderCard([
    step("a"),
    step("b", { isError: true, status: "failed" }),
  ]);

  assert.equal(
    container.querySelector("[data-run-phase]").dataset.runPhase,
    "error",
  );
  // Aggregate glyph is announced, not just drawn.
  getByText("1 step failed");
});

test("the header reads as active with the step position while live", async () => {
  const { container } = await renderCard([
    step("a"),
    step("b", { status: "executing", completedAt: null }),
  ]);

  // Scope to the card's own summary: the executing step row inside the body
  // announces its own status too.
  const header = container.querySelector("details > summary");
  assert.match(header.textContent, /Running/);
  assert.match(header.textContent, /step 2/);
});

test("a clean settled run announces done", async () => {
  const { container, getByText } = await renderCard([step("a"), step("b")]);
  assert.equal(
    container.querySelector("[data-run-phase]").dataset.runPhase,
    "done",
  );
  getByText("Done");
});

// ── Body ─────────────────────────────────────────────────────────────────────

test("the body renders one row per step and highlights the failing one", async () => {
  const { container } = await renderCard([
    step("a"),
    step("b", { isError: true, status: "failed" }),
    step("c"),
  ]);

  const rows = container.querySelectorAll(
    '[data-testid="transcript-tool-run-step"]',
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    [...rows].map((row) => row.dataset.stepFailed),
    [undefined, "true", undefined],
  );
});

test("the card carries the run id so streaming steps never remount it", async () => {
  const { container } = await renderCard([step("a"), step("b")]);
  assert.equal(
    container.querySelector("[data-tool-run-id]").dataset.toolRunId,
    "tool-run:a",
  );
});

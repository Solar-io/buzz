import assert from "node:assert/strict";
import { test, after } from "node:test";

// AgentVoicesCard under jsdom + act, with every data/publish boundary
// stubbed at its exact import specifier. The publish module stub exports
// BOTH publishers as recording spies, so the assertion "confirm publishes
// kind-30183 through the assignment publisher and NEVER the 30182 one" is a
// behaviour check, not a grep: re-wiring the card to
// publishAgentVoiceSelection makes the named test fail.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = "a".repeat(64);
const EVIE = "e".repeat(64);
const THEO = "7".repeat(64);
const SESSION = { id: "fake-session" };

const state = {
  agents: [
    { pubkey: EVIE, name: "Evie" },
    { pubkey: THEO, name: "Theo Bot" },
  ],
  assignments: new Map(),
  selections: new Map([
    [
      EVIE,
      {
        pubkey: EVIE,
        createdAt: 1,
        selection: { engine: "pocket", key: "pocket:anna" },
        label: "Anna",
      },
    ],
  ]),
  assignCalls: [],
  selectCalls: [],
  clearCalls: [],
  ingested: [],
  dialogProps: null,
};
globalThis.__AGENT_VOICES_TEST__ = state;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: ${JSON.stringify(SESSION)} };
    }
  `,
  "@/shared/lib/useOwnPubkey": `
    export function useOwnPubkey() { return "${OWNER}"; }
  `,
  "@/features/agents/useAgentRegistry": `
    export function useAgentRegistry() { return globalThis.__AGENT_VOICES_TEST__.agents; }
  `,
  "../hooks.ts": `
    const s = () => globalThis.__AGENT_VOICES_TEST__;
    export function useAgentVoiceAssignments() {
      return { byAgent: s().assignments, ready: true, assignmentFor: () => undefined,
        ingest: (e) => s().ingested.push(e) };
    }
    export function useAgentVoiceSelections() {
      return { byPubkey: s().selections, ready: true, agentVoiceSelectionFor: () => undefined };
    }
    export function useBridgeVoices() { return { voices: [], ready: true, error: null }; }
    export function useChatterboxVoices() {
      return { voices: [{ key: "chatterbox:evie", slug: "evie", label: "Evie", gender: "female",
        style: "", reserved: true, reservedFor: null }], ready: true };
    }
  `,
  "../lib/agentVoiceApi.ts": `
    const s = () => globalThis.__AGENT_VOICES_TEST__;
    export async function publishAgentVoiceAssignment(...args) { s().assignCalls.push(args); }
    export async function publishAgentVoiceSelection(...args) { s().selectCalls.push(args); }
    export async function clearAgentVoiceAssignment(...args) {
      s().clearCalls.push(args);
      return { kind: 5, pubkey: args[1], content: "", created_at: 9, tags: [] };
    }
  `,
  "./VoicePickerDialog.tsx": `
    export function VoicePickerDialog(props) {
      globalThis.__AGENT_VOICES_TEST__.dialogProps = props;
      return null;
    }
  `,
  "./voicePreview.ts": `
    export function createVoicePreviewer() {
      return { preview() {}, dispose() {} };
    }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentVoicesCard } = await import("./AgentVoicesCard.tsx");

async function mount() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AgentVoicesCard));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(node) {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

test("the card lists the owner's agents with effective voice and source chip", async () => {
  const { container, unmount } = await mount();
  assert.ok(container.querySelector('[data-testid="settings-agent-voices"]'));
  const rows = [
    ...container.querySelectorAll('[data-testid="agent-voices-row"]'),
  ];
  assert.equal(rows.length, 2);
  const values = rows.map(
    (row) =>
      row.querySelector('[data-testid="agent-voices-value"]').textContent,
  );
  assert.match(values[0], /^Anna \(Pocket\)agent's choice$/);
  assert.match(values[1], /\(Chatterbox\)default$/);
  await unmount();
});

test("confirm publishes the 30183 assignment for THAT agent and never a 30182", async () => {
  state.assignCalls.length = 0;
  state.selectCalls.length = 0;
  const { container, unmount } = await mount();
  const change = container.querySelectorAll(
    '[data-testid="agent-voices-change"]',
  );
  assert.equal(change.length, 2);
  await click(change[0]);
  assert.equal(state.dialogProps.open, true);
  assert.equal(state.dialogProps.mode, "assign");
  assert.deepEqual(state.dialogProps.target, { pubkey: EVIE, name: "Evie" });
  await act(async () => {
    await state.dialogProps.onConfirm(
      { engine: "chatterbox", key: "chatterbox:evie" },
      "Evie",
    );
  });
  assert.equal(state.assignCalls.length, 1, "exactly one assignment publish");
  const [session, agent, selection, label] = state.assignCalls[0];
  assert.deepEqual(session, SESSION);
  assert.equal(agent, EVIE);
  assert.deepEqual(selection, { engine: "chatterbox", key: "chatterbox:evie" });
  assert.equal(label, "Evie");
  assert.equal(
    state.selectCalls.length,
    0,
    "the 30182 publisher is never called",
  );
  await unmount();
});

test("Reset is offered only for an assigned agent and deletes by coordinate", async () => {
  state.assignments = new Map([
    [
      THEO,
      {
        agentPubkey: THEO,
        ownerPubkey: OWNER,
        createdAt: 5,
        selection: { engine: "chatterbox", key: "chatterbox:theo" },
        label: "Theo",
      },
    ],
  ]);
  state.clearCalls.length = 0;
  state.ingested.length = 0;
  const { container, unmount } = await mount();
  const resets = container.querySelectorAll(
    '[data-testid="agent-voices-reset"]',
  );
  assert.equal(resets.length, 1, "only Theo Bot has an assignment");
  const theoValue = container.querySelectorAll(
    '[data-testid="agent-voices-value"]',
  )[1].textContent;
  assert.match(theoValue, /^Theo \(Chatterbox\)set by you$/);
  await click(resets[0]);
  assert.equal(state.clearCalls.length, 1);
  assert.equal(state.clearCalls[0][1], OWNER);
  assert.equal(state.clearCalls[0][2], THEO);
  assert.equal(state.ingested.length, 1, "the deletion is folded locally");
  await unmount();
  state.assignments = new Map();
});

test("the card is hidden for an identity with no agents", async () => {
  const saved = state.agents;
  state.agents = [];
  const { container, unmount } = await mount();
  assert.equal(
    container.querySelector('[data-testid="settings-agent-voices"]'),
    null,
  );
  await unmount();
  state.agents = saved;
});

test("Agent voices preserves a removed Fish label, shows its badge and passes it to assignment", async () => {
  state.assignments = new Map([
    [
      EVIE,
      {
        agentPubkey: EVIE,
        selection: {
          engine: "fish",
          key: "fish:0123456789abcdef0123456789abcdef",
        },
        label: "Stored Jame",
      },
    ],
  ]);
  const { container, unmount } = await mount();
  assert.match(
    container.textContent,
    /Stored Jame \(Fish Audio\).*not in library/,
  );
  await click(container.querySelector('[data-testid="agent-voices-change"]'));
  assert.equal(state.dialogProps.current.engine, "fish");
  assert.equal(state.dialogProps.currentLabel, "Stored Jame");
  await unmount();
  state.assignments = new Map();
});

after(() => {
  delete globalThis.__BUZZ_TEST_MODULE_STUBS__;
  delete globalThis.__AGENT_VOICES_TEST__;
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

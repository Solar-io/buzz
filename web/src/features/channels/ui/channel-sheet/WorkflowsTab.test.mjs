import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of [
  "HTMLElement",
  "HTMLTextAreaElement",
  "Node",
  "Event",
  "getComputedStyle",
])
  globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
const { default: React, act } = await import("react");
const { createRoot } = await import("react-dom/client");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/features/auth/ui/AuthProvider": `export function useAuth() { return {canSign: globalThis.canSign}; }`,
  "@/features/workflows/useWorkflows": `export function useWorkflows() { return {workflows:globalThis.workflows, connected:globalThis.connected, loading:false}; }`,
  "@/features/workflows/useWorkflowRuns": `export function useLatestRuns(ids) { globalThis.runIds = ids; return globalThis.runs; }`,
  "@/shared/api/RelaySessionProvider": `export function useRelaySession() { return {session:globalThis.session}; }`,
  "@/shared/lib/nostr-signer": `export async function ownPubkey() { return 'viewer'; } export async function signNostrEvent(event) { return {...event,id:'signed',pubkey:'viewer'}; }`,
};
const { WorkflowsTab } = await import("./WorkflowsTab.tsx");
const { workflowFromEvent } = await import(
  "@/features/workflows/lib/workflowDefinition.ts"
);
const { NEW_WORKFLOW_YAML } = await import(
  "@/features/workflows/lib/workflowPublish.ts"
);
const summary = (id, channel, owner = "viewer") =>
  workflowFromEvent({
    id: `revision-${id}`,
    pubkey: owner,
    created_at: 1,
    kind: 30620,
    tags: [
      ["d", id],
      ["h", channel],
    ],
    content: NEW_WORKFLOW_YAML.replace("New workflow", id),
  });

async function mount(writable = true) {
  globalThis.canSign = true;
  globalThis.connected = true;
  globalThis.workflows = [
    summary("Mine", "here"),
    summary("Foreign", "here", "other"),
    summary("Elsewhere", "there"),
  ];
  globalThis.runs = new Map([
    [
      "Mine",
      { runs: [{ id: "run", status: "completed", createdAt: 1 }], next: null },
    ],
    ["Foreign", { runs: [], next: null }],
  ]);
  const published = [];
  globalThis.session = {
    publish: async (event) => {
      published.push(event);
      return { ok: true, message: "" };
    },
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const props = {
    channelId: "here",
    writable,
    onBusyChange: (busy) => {
      globalThis.editorBusy = busy;
    },
  };
  const render = async () =>
    act(async () => root.render(React.createElement(WorkflowsTab, props)));
  await render();
  return {
    node,
    published,
    render,
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
    },
  };
}
const button = (node, text) =>
  [...node.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
async function input(node, value) {
  const textarea = node.querySelector("textarea");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("channel rows exclude other channels, show run status and restrict editing to the author", async () => {
  const view = await mount();
  try {
    assert.match(view.node.textContent, /Mine/);
    assert.match(view.node.textContent, /Foreign/);
    assert.doesNotMatch(view.node.textContent, /Elsewhere/);
    assert.match(view.node.textContent, /completed/);
    assert.match(view.node.textContent, /No runs yet/);
    assert.equal(view.node.querySelectorAll('[aria-label^="Edit "]').length, 1);
    assert.deepEqual(globalThis.runIds, ["Mine", "Foreign"]);
  } finally {
    await view.close();
  }
});
test("invalid YAML disables Save and shows the line", async () => {
  const view = await mount();
  try {
    await act(async () => button(view.node, "New workflow").click());
    await input(view.node, "name: Broken\ntrigger:\n  on: [bad\n");
    assert.equal(button(view.node, "Save").disabled, true);
    assert.match(
      view.node.querySelector('[role="alert"]').textContent,
      /line 3/,
    );
    assert.equal(
      view.node.querySelector("textarea").getAttribute("aria-invalid"),
      "true",
    );
    await input(view.node, NEW_WORKFLOW_YAML);
    assert.equal(button(view.node, "Save").disabled, false);
    assert.equal(view.node.querySelector('[role="alert"]'), null);
    assert.equal(view.published.length, 0);
  } finally {
    await view.close();
  }
});
test("Save signs and publishes a new scoped workflow, then accepts its live echo", async () => {
  const view = await mount();
  try {
    await act(async () => button(view.node, "New workflow").click());
    await input(
      view.node,
      NEW_WORKFLOW_YAML.replace("New workflow", "Created"),
    );
    await act(async () => button(view.node, "Save").click());
    assert.equal(view.published.length, 1);
    const event = view.published[0];
    assert.equal(event.kind, 30620);
    assert.deepEqual(event.tags[1], ["h", "here"]);
    assert.match(event.content, /name: Created/);
    assert.equal(view.node.querySelector("textarea") === null, true);
    globalThis.workflows.push(workflowFromEvent({ ...event, created_at: 2 }));
    await view.render();
    assert.match(view.node.textContent, /Created/);
  } finally {
    await view.close();
  }
});
test("editing preserves the selected workflow id and revision", async () => {
  const view = await mount();
  try {
    await act(async () =>
      view.node.querySelector('[aria-label="Edit Mine"]').click(),
    );
    assert.match(view.node.querySelector("textarea").value, /name: Mine/);
    await input(
      view.node,
      NEW_WORKFLOW_YAML.replace("New workflow", "Renamed"),
    );
    await act(async () => button(view.node, "Save").click());
    assert.deepEqual(view.published[0].tags, [
      ["d", "Mine"],
      ["h", "here"],
      ["expected-revision", "revision-Mine"],
    ]);
  } finally {
    await view.close();
  }
});
test("relay refusals are verbatim plain text and keep the draft open", async () => {
  const view = await mount();
  try {
    globalThis.session.publish = async () => ({
      ok: false,
      message: "invalid: step 1 <script>alert(1)</script>",
    });
    await act(async () => button(view.node, "New workflow").click());
    await act(async () => button(view.node, "Save").click());
    assert.equal(
      view.node.querySelector('[role="alert"]').textContent,
      "invalid: step 1 <script>alert(1)</script>",
    );
    assert.equal(view.node.querySelector("script"), null);
    assert.ok(view.node.querySelector("textarea"));
    assert.equal(button(view.node, "Save").disabled, false);
    assert.equal(globalThis.editorBusy, false);
  } finally {
    await view.close();
  }
});
test("read-only and offline states prevent create and edit", async () => {
  const view = await mount(false);
  try {
    assert.equal(button(view.node, "New workflow").disabled, true);
    assert.equal(button(view.node, "Edit").disabled, true);
    view.node.querySelector("button").click();
    assert.equal(view.node.querySelector("textarea") === null, true);
    globalThis.connected = false;
    await view.render();
    assert.deepEqual(globalThis.runIds, []);
  } finally {
    await view.close();
  }
});
test("Cancel returns to the list without publishing", async () => {
  const view = await mount();
  try {
    await act(async () => button(view.node, "New workflow").click());
    await act(async () => button(view.node, "Cancel").click());
    assert.equal(view.node.querySelector("textarea") === null, true);
    assert.equal(view.published.length, 0);
  } finally {
    await view.close();
  }
});
test("retry after a relay timeout retains the create identity", async () => {
  const view = await mount();
  try {
    globalThis.session.publish = async (event) => {
      view.published.push(event);
      return { ok: false, message: "Timed out" };
    };
    await act(async () => button(view.node, "New workflow").click());
    await act(async () => button(view.node, "Save").click());
    await act(async () => button(view.node, "Save").click());
    assert.equal(view.published.length, 2);
    assert.deepEqual(view.published[0].tags, view.published[1].tags);
  } finally {
    await view.close();
  }
});
test("loss of connection locks an open editor", async () => {
  const view = await mount();
  try {
    await act(async () => button(view.node, "New workflow").click());
    globalThis.connected = false;
    await view.render();
    assert.equal(button(view.node, "Save").disabled, true);
    assert.equal(view.published.length, 0);
  } finally {
    await view.close();
  }
});

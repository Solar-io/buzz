import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
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
  "@/features/channels/ui/MarkdownContent": `export function MarkdownContent({content}) { return globalThis.React.createElement('div', {'data-md': ''}, content); }`,
  "@/features/channels/hooks": `
    export function useChannelMembers() { return globalThis.members; }
    export async function sendChannelMessage(session, options) { globalThis.sent.push(options); globalThis.order.push('publish'); return { ok: true, message: '' }; }`,
  "@/shared/api/RelaySessionProvider": `export function useRelaySession() { return { session: {}, status: 'open' }; }`,
  "@/features/work/lib/ownSends.ts": `export function recordOwnSend() {}`,
  "@/shared/ui/notify": `export const notify = { sendError() {}, sendFailure() {} };`,
};
const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentBox, FileThread } = await import("./FileComments.tsx");
const { agentTarget } = await import("../lib/agentTarget.ts");
after(() => dom.window.close());

const SELF = "self".padEnd(64, "0");
const HUMAN = "human".padEnd(64, "0");
const AGENT = "agent".padEnd(64, "0");
const OTHER_AGENT = "other".padEnd(64, "0");
const agents = new Set([AGENT, OTHER_AGENT]);
const names = {
  person: (pubkey) =>
    ({ [AGENT]: "Gilfoyle", [OTHER_AGENT]: "Nikon", [HUMAN]: "Sam" })[pubkey] ??
    "someone",
  isAgent: (pubkey) => agents.has(pubkey),
};

async function mount(props) {
  globalThis.sent = [];
  globalThis.order = [];
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      React.createElement(AgentBox, {
        quote: null,
        onClearQuote: () => {},
        selfPubkey: SELF,
        names,
        comments: [],
        context: {
          filename: "report.md",
          path: "crichton:/Users/sam/report.md",
          editedSinceShared: false,
        },
        ...props,
      }),
    ),
  );
  return {
    node,
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
    },
  };
}

async function type(view, text) {
  const field = view.node.querySelector('[data-testid="file-comment-input"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(field, text);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function click(view, testId) {
  const el = view.node.querySelector(`[data-testid="${testId}"]`);
  assert.ok(el, `${testId} exists`);
  await act(async () => el.click());
}

const share = (authorPubkey) => ({
  id: "s".repeat(64),
  channelId: "chan",
  authorPubkey,
  rootId: null,
  replyToId: null,
});

test("a human-authored share with one agent member mentions the agent, not the author", async () => {
  globalThis.members = [{ pubkey: SELF }, { pubkey: HUMAN }, { pubkey: AGENT }];
  const view = await mount({ share: share(HUMAN) });
  try {
    const target = view.node.querySelector('[data-testid="agent-box-target"]');
    assert.equal(target.tagName, "SELECT");
    assert.equal(target.value, AGENT);
    assert.equal(
      view.node
        .querySelector('[data-testid="agent-box-send"]')
        .getAttribute("aria-label"),
      "Send to Gilfoyle",
    );
    await type(view, "Fix the dates");
    await click(view, "agent-box-send");
    assert.equal(globalThis.sent.length, 1);
    assert.deepEqual(globalThis.sent[0].mentionPubkeys, [AGENT]);
    assert.equal(
      globalThis.sent[0].content,
      "Fix the dates\n\n[file: report.md · crichton:/Users/sam/report.md]",
    );
    assert.deepEqual(globalThis.sent[0].threadRef, {
      rootId: "s".repeat(64),
      replyToId: "s".repeat(64),
    });
  } finally {
    await view.close();
  }
});

test("an agent's own share goes to that agent, with the placeholder naming it", async () => {
  globalThis.members = [
    { pubkey: SELF },
    { pubkey: AGENT },
    { pubkey: OTHER_AGENT },
  ];
  const view = await mount({ share: share(AGENT) });
  try {
    assert.equal(
      view.node.querySelector('[data-testid="file-comment-input"]').placeholder,
      "Ask Gilfoyle to change this document…",
    );
    await type(view, "Rewrite it");
    await click(view, "agent-box-send");
    assert.deepEqual(globalThis.sent[0].mentionPubkeys, [AGENT]);
  } finally {
    await view.close();
  }
});

test("a dirty draft asks first; Save and send saves BEFORE publishing", async () => {
  globalThis.members = [{ pubkey: AGENT }];
  let saved = 0;
  const view = await mount({
    share: share(AGENT),
    dirty: true,
    saveDraft: async () => {
      saved += 1;
      globalThis.order.push("save");
      return true;
    },
  });
  try {
    await type(view, "Now tidy it");
    await click(view, "agent-box-send");
    assert.equal(globalThis.sent.length, 0, "nothing sent before the choice");
    await click(view, "agent-box-save-and-send");
    assert.equal(saved, 1);
    assert.deepEqual(globalThis.order, ["save", "publish"]);
  } finally {
    await view.close();
  }
});

test("a failed save sends nothing (the agent never edits under a stale draft)", async () => {
  globalThis.members = [{ pubkey: AGENT }];
  const view = await mount({
    share: share(AGENT),
    dirty: true,
    saveDraft: async () => false,
  });
  try {
    await type(view, "go");
    await click(view, "agent-box-send");
    await click(view, "agent-box-save-and-send");
    assert.equal(globalThis.sent.length, 0);
  } finally {
    await view.close();
  }
});

test("the thread shows the trailer as a visible chip, not raw text; the highlight still renders", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const comment = {
    id: "c1",
    replyToId: "s",
    createdAt: 1,
    authorPubkey: SELF,
    content:
      "> the Q3 row\n\nFix the dates\n\n[file: report.md · crichton:/Users/sam/report.md]",
  };
  await act(async () =>
    root.render(
      React.createElement(FileThread, { comments: [comment], names }),
    ),
  );
  assert.ok(!node.textContent.includes("[file:"));
  assert.equal(
    node.querySelector('[data-testid="file-comment-trailer"]').textContent,
    "report.md · crichton:/Users/sam/report.md",
  );
  assert.ok(node.textContent.includes("the Q3 row"));
  assert.ok(node.textContent.includes("Fix the dates"));
  assert.ok(node.textContent.includes("Agent thread · 1"));
  await act(async () => root.unmount());
  node.remove();
});

test("agentTarget: defaults, explicit pick, and the note fallback", () => {
  const base = {
    selfPubkey: SELF,
    isAgent: names.isAgent,
    comments: [],
    picked: null,
  };
  // Two agents, nobody replied yet: the person must pick.
  assert.deepEqual(
    agentTarget({
      ...base,
      authorPubkey: HUMAN,
      memberPubkeys: [AGENT, OTHER_AGENT],
    }),
    { mode: "picker", options: [AGENT, OTHER_AGENT], target: null },
  );
  // The last agent that replied wins.
  assert.equal(
    agentTarget({
      ...base,
      authorPubkey: HUMAN,
      memberPubkeys: [AGENT, OTHER_AGENT],
      comments: [
        { authorPubkey: AGENT },
        { authorPubkey: OTHER_AGENT },
        { authorPubkey: HUMAN },
      ],
    }).target,
    OTHER_AGENT,
  );
  assert.equal(
    agentTarget({
      ...base,
      authorPubkey: HUMAN,
      memberPubkeys: [AGENT, OTHER_AGENT],
      picked: AGENT,
    }).target,
    AGENT,
  );
  assert.deepEqual(
    agentTarget({ ...base, authorPubkey: HUMAN, memberPubkeys: [HUMAN] }),
    {
      mode: "note",
      target: null,
    },
  );
  assert.deepEqual(
    agentTarget({ ...base, authorPubkey: AGENT, memberPubkeys: [] }),
    {
      mode: "author",
      target: AGENT,
    },
  );
});

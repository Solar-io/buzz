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
  "@/features/channels/ui/MarkdownContent": `export function MarkdownContent({content}) { return globalThis.React.createElement('div', null, content); }`,
  "@/features/shelf/useShareNames.ts": `export function useShareNames() { return { channel: () => '#canvas-test', person: () => 'Writer' }; }`,
  "@/features/channels/hooks": `export function useChannelMembers() { return globalThis.members; }`,
  "@/features/work/workContext.ts": `export function useWorkContext() { return globalThis.work; }`,
  "@/shared/api/RelaySessionProvider": `export function useRelaySession() { return { session: globalThis.session, status: globalThis.status }; }`,
  "@/shared/lib/nostr-signer": `export async function signNostrEvent(event) { return {...event, id:'signed', pubkey:'self', sig:'signature'}; }`,
};
const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChannelCanvasView } = await import("./ChannelCanvasView.tsx");
after(() => dom.window.close());

async function mount({
  content = "# Original",
  archived = false,
  member = true,
  status = "open",
} = {}) {
  globalThis.work = {
    selfPubkey: "self",
    channels: [{ id: "canvas-test", archived }],
  };
  globalThis.members = member ? [{ pubkey: "self" }] : [];
  globalThis.status = status;
  const published = [];
  globalThis.session = {
    publish: async (event) => {
      published.push(event);
      return { ok: true, message: "" };
    },
  };
  let doc =
    content === null
      ? null
      : {
          channelId: "canvas-test",
          eventId: "original",
          content,
          authorPubkey: "author",
          updatedAt: Math.floor(Date.now() / 1000),
        };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const render = async () =>
    act(async () =>
      root.render(
        React.createElement(ChannelCanvasView, {
          channelId: "canvas-test",
          doc,
          phase: "ready",
          expanded: false,
        }),
      ),
    );
  await render();
  return {
    node,
    published,
    render,
    echo: async (content) => {
      doc = {
        ...doc,
        content,
        eventId: "echo",
        updatedAt: (doc?.updatedAt ?? 0) + 1,
        authorPubkey: "self",
      };
      await render();
    },
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
    },
  };
}
function button(view, name) {
  return [...view.node.querySelectorAll("button")].find(
    (item) => item.textContent.trim() === name,
  );
}
async function click(view, name) {
  const target = button(view, name);
  assert.ok(target, `${name} exists`);
  await act(async () => target.click());
}
async function input(view, content) {
  const field = view.node.querySelector("textarea");
  assert.ok(field);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(field, content);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("a save shows the new canvas content after the echo, not the publish OK", async () => {
  const view = await mount();
  try {
    await click(view, "Edit");
    await input(view, "# Updated\n\nHello **team**.");
    await click(view, "Save");
    assert.equal(view.published.length, 1);
    const event = view.published[0];
    assert.equal(event.kind, 40100);
    assert.deepEqual(event.tags, [["h", "canvas-test"]]);
    assert.equal(event.content, "# Updated\n\nHello **team**.");
    assert.equal(event.sig, "signature");
    assert.ok(
      event.created_at > Math.floor(Date.now() / 1000),
      "rapid edits beat the current second",
    );
    assert.equal(
      view.node.querySelector('[data-testid="channel-canvas-body"]')
        .textContent,
      "# Original",
    );
    await view.echo(event.content);
    assert.equal(
      view.node.querySelector('[data-testid="channel-canvas-body"]')
        .textContent,
      event.content,
    );
  } finally {
    await view.close();
  }
});

test("canvas refusal quotes the relay error and keeps the draft for retry", async () => {
  const view = await mount();
  try {
    globalThis.session.publish = async () => ({
      ok: false,
      message: "Membership required",
    });
    await click(view, "Edit");
    await input(view, "Do not lose this draft");
    await click(view, "Save");
    assert.equal(
      view.node.querySelector('[role="alert"]').textContent,
      "Membership required",
    );
    assert.equal(
      view.node.querySelector("textarea").value,
      "Do not lose this draft",
    );
    assert.equal(button(view, "Save").disabled, false);
  } finally {
    await view.close();
  }
});

test("Clear confirms and appends empty content; the empty canvas stays editable after echo", async () => {
  const view = await mount();
  try {
    window.confirm = () => false;
    await click(view, "Clear");
    assert.equal(view.published.length, 0);
    window.confirm = () => true;
    await click(view, "Clear");
    assert.equal(view.published.length, 1);
    assert.deepEqual(view.published[0].tags, [["h", "canvas-test"]]);
    assert.equal(view.published[0].content, "");
    await view.echo("");
    assert.ok(view.node.querySelector('[data-testid="channel-canvas-empty"]'));
    assert.ok(button(view, "Edit"));
    assert.equal(button(view, "Clear"), undefined);
  } finally {
    await view.close();
  }
});

test("a pending canvas save disables edits and submits only once", async () => {
  const view = await mount();
  let finish;
  try {
    globalThis.session.publish = (event) => {
      view.published.push(event);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    await click(view, "Edit");
    await input(view, "Pending");
    await click(view, "Save");
    assert.equal(view.node.querySelector("textarea").disabled, true);
    assert.equal(button(view, "Saving…").disabled, true);
    assert.equal(button(view, "Cancel").disabled, true);
    await click(view, "Saving…");
    assert.equal(view.published.length, 1);
    await act(async () => finish({ ok: true, message: "" }));
    assert.ok(button(view, "Edit"));
  } finally {
    await view.close();
  }
});

test("an empty canvas can be created and Cancel sends no update", async () => {
  const view = await mount({ content: null });
  try {
    assert.ok(view.node.querySelector('[data-testid="channel-canvas-empty"]'));
    await click(view, "Edit");
    await input(view, "New canvas");
    await click(view, "Cancel");
    assert.equal(view.published.length, 0);
    await click(view, "Edit");
    assert.equal(view.node.querySelector("textarea").value, "");
  } finally {
    await view.close();
  }
});

test("archived, non-member and disconnected canvases have no write controls", async () => {
  for (const options of [
    { archived: true },
    { member: false },
    { status: "closed" },
  ]) {
    const view = await mount(options);
    try {
      assert.equal(button(view, "Edit"), undefined);
      assert.equal(button(view, "Clear"), undefined);
      assert.ok(view.node.querySelector('[data-testid="channel-canvas-body"]'));
    } finally {
      await view.close();
    }
  }
});

test("a remote canvas echo preserves an open draft and warns before replacement", async () => {
  const view = await mount();
  try {
    await click(view, "Edit");
    await input(view, "My draft");
    await view.echo("Another member’s edit");
    assert.equal(view.node.querySelector("textarea").value, "My draft");
    assert.match(
      view.node.querySelector('[role="status"]').textContent,
      /Saving will replace it/,
    );
  } finally {
    await view.close();
  }
});

import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";

// Capture dialog under jsdom + act — the FileViewerDialog pattern. The drop
// surface is exercised with real bubbling drag events; jsdom has no
// DataTransfer/DragEvent constructors, so the event carries a
// DataTransfer-shaped object pinned onto it (React reads
// `nativeEvent.dataTransfer` by name, which a pinned property satisfies).
// Everything except the relay/emoji/pubkey boundaries is the real tree.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  uploads: globalThis.__BUZZ_TEST_UPLOADS__,
  toasts: globalThis.__BUZZ_TEST_TOASTS__,
  createObjectURL: globalThis.URL.createObjectURL,
  revokeObjectURL: globalThis.URL.revokeObjectURL,
};
// Node's URL.createObjectURL only takes Node Blobs — jsdom Files throw. The
// image-preview path in the composer calls it with whatever File it was
// handed, so stand in a counter (browsers accept any Blob; this is purely a
// Node-vs-jsdom seam).
let objectUrlCounter = 0;
globalThis.URL.createObjectURL = () => {
  objectUrlCounter += 1;
  return `blob:test-${objectUrlCounter}`;
};
globalThis.URL.revokeObjectURL = () => {};
// Node natives that must lose to the jsdom constructors (React event
// dispatch requires jsdom nodes to receive jsdom Events).
const FORCE_JSOM = new Set([
  "Event",
  "EventTarget",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "getComputedStyle",
]);
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === "window" || key === "document" || key === "globalThis") {
    continue;
  }
  if (FORCE_JSOM.has(key) || !(key in globalThis)) {
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
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
globalThis.__BUZZ_TEST_REACT__ = React;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/blossom": `export function uploadBlob(file, options) { return globalThis.__ITEM_UPLOAD__(file, options); }`,
  "@/shared/ui/dialog": `
    const React = globalThis.__BUZZ_TEST_REACT__;
    export function Dialog({open, children}) { return open ? children : null; }
    export const DialogContent = ({children, ...props}) => React.createElement("div", props, children);
    export const DialogHeader = ({children}) => React.createElement("div", {}, children);
    export const DialogFooter = DialogHeader;
    export const DialogTitle = ({children}) => React.createElement("h2", {}, children);
    export const DialogDescription = ({children}) => React.createElement("p", {}, children);
  `,
  sonner: `export const toast = { error(message) { globalThis.__BUZZ_TEST_TOASTS__?.push(message); } };`,
};
const { AddItemDialog } = await import("./AddItemDialog.tsx");
let root;
let host;
let submitted;
let pending;
let closed;
let calls;
let revoked;

function descriptor(file) {
  return {
    url: `https://media.test/${file.name}`,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    sha256: "a".repeat(64),
  };
}
async function mount() {
  submitted = [];
  pending = [];
  calls = [];
  revoked = [];
  globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
  closed = 0;
  globalThis.__BUZZ_TEST_TOASTS__ = [];
  globalThis.__ITEM_UPLOAD__ = (file, options) => {
    calls.push(file.name);
    options.onProgress?.(0.4);
    return new Promise((resolve, reject) =>
      pending.push({ file, resolve: () => resolve(descriptor(file)), reject }),
    );
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(AddItemDialog, {
        open: true,
        channels: [],
        projects: [],
        onClose: () => {
          closed += 1;
        },
        onCreate: async (input) => {
          submitted.push(input);
          return null;
        },
      }),
    ),
  );
  await fill(host.querySelector('input:not([type="file"])'), "Attachment bug");
}
async function fill(input, value) {
  await act(async () => {
    const prototype =
      input.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
const body = () =>
  host.querySelector('[data-testid="item-body-editor"] textarea');
const submitButton = () => host.querySelector('button[type="submit"]');
function file(name, type = "image/png") {
  return new dom.window.File(["bytes"], name, { type });
}
async function pick(files) {
  const input = host.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () =>
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true })),
  );
}
async function send() {
  await act(async () =>
    host
      .querySelector("form")
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
}
async function paste(files) {
  const event = new dom.window.Event("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: files.map((f) => ({ kind: "file", getAsFile: () => f })),
    },
  });
  await act(async () => body().dispatchEvent(event));
  return event;
}
async function finish(index = 0) {
  await act(async () => pending[index].resolve());
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  root = null;
});
after(() => {
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.URL.createObjectURL = originals.createObjectURL;
  globalThis.URL.revokeObjectURL = originals.revokeObjectURL;
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  Object.defineProperty(globalThis, "navigator", originals.navigator);
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  delete globalThis.__ITEM_UPLOAD__;
  dom.window.close();
});

test("capture waits for pending uploads in both button and direct form submission", async () => {
  await mount();
  await pick([file("shot.png")]);
  assert.equal(calls.length, 1);
  assert.equal(submitButton().disabled, true);
  assert.equal(
    host.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"),
    "40",
  );
  await send();
  assert.equal(submitted.length, 0);
  await finish();
  assert.equal(submitButton().disabled, false);
  await send();
  assert.equal(submitted.length, 1);
  assert.equal(closed, 1);
  assert.equal(submitted[0].body, "![shot.png](https://media.test/shot.png)\n");
});
test("completion uses the current cursor and preserves prose typed while uploading", async () => {
  await mount();
  await fill(body(), "before old after");
  await pick([file("shot.png")]);
  await fill(body(), "before latest after");
  body().setSelectionRange(7, 13);
  await finish();
  assert.equal(
    body().value,
    "before \n![shot.png](https://media.test/shot.png)\n after",
  );
  assert.equal(body().selectionStart, 49);
});
test("multiple batches are serial and create waits for the whole queue", async () => {
  await mount();
  await pick([file("one.png"), file("two.txt", "text/plain")]);
  await paste([file("three.png")]);
  assert.deepEqual(calls, ["one.png"]);
  await finish(0);
  assert.equal(submitButton().disabled, true);
  assert.deepEqual(calls, ["one.png", "two.txt"]);
  await finish(1);
  assert.equal(submitButton().disabled, true);
  await finish(2);
  assert.equal(submitButton().disabled, false);
  assert.equal(
    body().value,
    "![one.png](https://media.test/one.png)\n[two.txt](https://media.test/two.txt)\n![three.png](https://media.test/three.png)\n",
  );
});
test("file paste uploads a document once and text paste retains browser behavior", async () => {
  await mount();
  const pasted = await paste([file("evidence.pdf", "application/pdf")]);
  assert.equal(pasted.defaultPrevented, true);
  assert.equal(calls.length, 1);
  await finish();
  assert.equal(
    body().value,
    "[evidence.pdf](https://media.test/evidence.pdf)\n",
  );
  assert.equal((await paste([])).defaultPrevented, false);
});
test("drop shares the upload queue and advertised picker type filter", async () => {
  await mount();
  assert.equal(host.querySelector('input[type="file"]').multiple, true);
  assert.ok(
    host.querySelector('input[type="file"]').accept.includes("application/pdf"),
  );
  const drop = new dom.window.Event("drop", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(drop, "dataTransfer", {
    value: { types: ["Files"], files: [file("drop.png")] },
  });
  await act(async () =>
    host.querySelector('[data-testid="item-body-editor"]').dispatchEvent(drop),
  );
  assert.equal(drop.defaultPrevented, true);
  await finish();
  assert.match(body().value, /!\[drop.png\]/);
});
test("relay refusals remain visible with verbatim reasons and no broken markdown", async () => {
  await mount();
  await pick([file("bad.png")]);
  await act(async () =>
    pending[0].reject(new Error("Upload rejected (422): metadata forbidden")),
  );
  assert.equal(host.querySelector('[data-status="error"]') !== null, true);
  assert.match(host.textContent, /Upload rejected \(422\): metadata forbidden/);
  assert.equal(body().value, "");
  assert.equal(submitButton().disabled, false);
});
test("UTF-8 oversized bodies block create and uploaded markdown cannot cross the bound", async () => {
  await mount();
  await fill(body(), "é".repeat(8193));
  assert.equal(submitButton().disabled, true);
  await send();
  assert.equal(submitted.length, 0);
  await fill(body(), "é".repeat(8190));
  await pick([file("shot.png")]);
  await finish();
  assert.equal(body().value, "é".repeat(8190));
  assert.match(
    host.querySelector('[data-status="error"]').textContent,
    /16384 bytes/,
  );
});
test("removing in-flight uploads suppresses late insertion and completed removal removes markdown", async () => {
  await mount();
  await pick([file("removed.png")]);
  await act(async () =>
    host.querySelector('button[aria-label="Remove removed.png"]').click(),
  );
  await finish();
  assert.equal(body().value, "");
  assert.equal(submitButton().disabled, false);
  await pick([file("kept.png")]);
  await finish(1);
  assert.match(body().value, /kept.png/);
  await act(async () =>
    host.querySelector('button[aria-label="Remove kept.png"]').click(),
  );
  assert.equal(body().value.trim(), "");
});
test("closing the dialog invalidates an upload and unmount releases previews", async () => {
  await mount();
  await pick([file("late.png")]);
  await act(async () =>
    root.render(
      React.createElement(AddItemDialog, {
        open: false,
        channels: [],
        projects: [],
        onClose() {},
        onCreate: async () => null,
      }),
    ),
  );
  await finish();
  assert.equal(host.querySelector('[data-testid="item-body-editor"]'), null);
  assert.equal(revoked.length, 1);
});

test("immediately resolved multi-file uploads keep selection order before React paints", async () => {
  await mount();
  globalThis.__ITEM_UPLOAD__ = async (file) => descriptor(file);
  await fill(body(), "before after");
  body().setSelectionRange(6, 6);
  await pick([file("one.png"), file("two.png")]);
  assert.equal(
    body().value,
    "before\n![one.png](https://media.test/one.png)\n![two.png](https://media.test/two.png)\n after",
  );
});

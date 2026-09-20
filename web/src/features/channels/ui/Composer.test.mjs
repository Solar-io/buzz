import assert from "node:assert/strict";
import { test, after } from "node:test";

// Composer under jsdom + act — the FileViewerDialog pattern. The drop
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
const globalKeysBefore = new Set(Object.getOwnPropertyNames(globalThis));
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
  // The real upload path (XHR + hashing) is out of scope here; the queue
  // and tray under test ride on it through this seam.
  "@/shared/api/blossom": `
    export async function uploadBlob(file) {
      const seen = globalThis.__BUZZ_TEST_UPLOADS__;
      seen?.push(file.name);
      return {
        url: "https://media.test/blob/" + file.name,
        sha256: "a".repeat(64),
        mime_type: file.type || "application/octet-stream",
        size: file.size,
      };
    }
  `,
  "@/shared/lib/useOwnPubkey": `
    export function useOwnPubkey() {
      return null;
    }
  `,
  "@/features/custom-emoji/hooks": `
    export function useCustomEmoji() {
      return [];
    }
  `,
  "@/shared/ui/EmojiPicker": `
    export function EmojiPicker() {
      return null;
    }
  `,
  "@/features/custom-emoji/lib/customEmojiTags": `
    export function buildCustomEmojiTags() {
      return [];
    }
  `,
  // Relay unfurl probe would leave jsdom; keep the test hermetic.
  "../lib/useComposerLinkPreviews.ts": `
    export function useComposerLinkPreviews() {
      return {
        cards: [],
        suppressed: false,
        suppress() {},
        reset() {},
        tagsFor() {
          return [];
        },
      };
    }
  `,
  sonner: `
    export const toast = {
      error(message) {
        globalThis.__BUZZ_TEST_TOASTS__?.push(String(message));
      },
      message(message) {
        globalThis.__BUZZ_TEST_TOASTS__?.push(String(message));
      },
    };
  `,
};

const { Composer } = await import("./Composer.tsx");

function toastLines() {
  return globalThis.__BUZZ_TEST_TOASTS__ ?? [];
}

function jsdomFile(name, type, size = 12) {
  return new dom.window.File(["x".repeat(size)], name, { type });
}

// A DataTransfer-shaped object: `files` for the drop, `types` for the
// dragover-safe signal, `items` for the overlay count.
function dataTransfer({ files = [], types }) {
  return {
    files,
    types: types ?? (files.length > 0 ? ["Files"] : ["text/plain"]),
    items: { length: files.length },
  };
}

function dragEvent(type, transfer) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  return event;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountComposer(options = {}) {
  globalThis.__BUZZ_TEST_UPLOADS__ = [];
  globalThis.__BUZZ_TEST_TOASTS__ = [];
  const sent = [];
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    members: options.members ?? [],
    profiles: options.profiles ?? new Map(),
    strictMentions: options.strictMentions ?? false,
    send:
      options.send ??
      (async (payload) => {
        sent.push(payload);
        return { ok: true, message: "" };
      }),
  };
  if (!options.omitThreadProps) {
    // The channel main composer's historical shape. `omitThreadProps` mounts
    // the composer the way repos.tsx does NOW — no threadRef at all.
    props.threadRef = null;
    props.onClearThread = () => {};
  }
  await act(async () => {
    root.render(React.createElement(Composer, props));
  });
  await flush();
  return {
    container,
    sent,
    // React's enter/leave plugin ignores events whose target IS the root
    // container, so drags are dispatched on the textarea inside it — the
    // real path anyway — and bubble up to the composer root.
    drag: async (type, transfer) => {
      const input = container.querySelector('[data-testid="composer-input"]');
      await act(async () => {
        input.dispatchEvent(dragEvent(type, transfer));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

after(() => {
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (!globalKeysBefore.has(key)) {
      try {
        delete globalThis[key];
      } catch {
        // Non-configurable — leave it.
      }
    }
  }
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.__BUZZ_TEST_UPLOADS__ = originals.uploads;
  globalThis.__BUZZ_TEST_TOASTS__ = originals.toasts;
  globalThis.URL.createObjectURL = originals.createObjectURL;
  globalThis.URL.revokeObjectURL = originals.revokeObjectURL;
});

test("a mixed file drop queues the good files and toasts the rejected one", async () => {
  const composer = await mountComposer();
  try {
    const png = jsdomFile("shot.png", "image/png");
    const mp3 = jsdomFile("voice.mp3", "audio/mpeg");
    const txt = jsdomFile("notes.txt", "text/plain");

    await composer.drag("dragenter", dataTransfer({ files: [png, mp3, txt] }));
    assert.ok(
      composer.container.querySelector('[data-testid="composer-drop-overlay"]'),
      "file drag opens the overlay",
    );
    assert.match(
      composer.container.querySelector('[data-testid="composer-drop-overlay"]')
        ?.textContent ?? "",
      /3 files/,
      "overlay announces how many files the drag carries",
    );

    await composer.drag("drop", dataTransfer({ files: [png, mp3, txt] }));

    assert.deepEqual(
      globalThis.__BUZZ_TEST_UPLOADS__,
      ["shot.png", "notes.txt"],
      "accepted files upload in drop order, the audio never starts",
    );
    const rows = [
      ...composer.container.querySelectorAll(
        '[data-testid="composer-attachment"]',
      ),
    ];
    assert.equal(rows.length, 2, "one tray row per accepted file");
    assert.match(rows[0].textContent ?? "", /shot\.png/, "drop order kept");
    assert.match(rows[1].textContent ?? "", /notes\.txt/);
    assert.deepEqual(
      toastLines(),
      ["voice.mp3: Audio uploads are not accepted yet."],
      "the rejection surfaces with the picker's words",
    );
    assert.ok(
      !composer.container.querySelector(
        '[data-testid="composer-drop-overlay"]',
      ),
      "overlay closes after the drop",
    );
  } finally {
    // Unmount even on a failed assertion — a mounted React root keeps the
    // process's event loop alive and the runner would never exit.
    await composer.unmount();
  }
});

// The mutation guard: removing the has-files check on dragenter (opening the
// overlay for ANY drag) or on drop must fail THIS test by name. A text drag
// is the common case — dragging a URL or a selected sentence across the chat.
test("a text-only drag never opens the overlay and a text-only drop changes nothing", async () => {
  const composer = await mountComposer();
  try {
    const textDrag = dataTransfer({ files: [], types: ["text/plain"] });
    await composer.drag("dragenter", textDrag);
    // assert.ok, not assert.equal(el, null): a failing equal formats the
    // element into the message, and Node's inspector wedges on jsdom nodes.
    assert.ok(
      !composer.container.querySelector(
        '[data-testid="composer-drop-overlay"]',
      ),
      "no overlay for a drag that carries no files",
    );

    await composer.drag("drop", textDrag);
    assert.ok(
      !composer.container.querySelector(
        '[data-testid="composer-drop-overlay"]',
      ),
      "no overlay after a text-only drop",
    );
    assert.deepEqual(globalThis.__BUZZ_TEST_UPLOADS__, []);
    assert.deepEqual(
      composer.container.querySelectorAll('[data-testid="composer-attachment"]')
        .length,
      0,
      "no tray rows appear",
    );
    assert.deepEqual(toastLines(), []);
  } finally {
    await composer.unmount();
  }
});

test("strict huddle mentions retain an unresolved draft and publish nothing", async () => {
  const member = "a".repeat(64);
  const composer = await mountComposer({
    strictMentions: true,
    members: [{ pubkey: member, name: "Trevor Lefkowitz" }],
    profiles: new Map([
      [member, { name: "Trevor Lefkowitz", displayName: "Trevor Lefkowitz" }],
    ]),
  });
  try {
    const input = composer.container.querySelector(
      '[data-testid="composer-input"]',
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      ).set.call(input, "hello @Trevor");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
    await act(async () => {
      composer.container
        .querySelector('[aria-label="Send"]')
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
    assert.equal(
      input.value,
      "hello @Trevor",
      "the unresolved draft stays visible",
    );
    assert.deepEqual(composer.sent, [], "the strict composer does not publish");
    assert.match(toastLines()[0] ?? "", /Resolve huddle mention/);
  } finally {
    await composer.unmount();
  }
});

test("strict huddle mode still sends ordinary email and package text", async () => {
  const composer = await mountComposer({
    strictMentions: true,
    members: [{ pubkey: "a".repeat(64), name: "Trevor Lefkowitz" }],
  });
  try {
    const input = composer.container.querySelector(
      '[data-testid="composer-input"]',
    );
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(input, "Email support@example.com about @scope/package.");
    await act(async () => {
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
    await act(async () => {
      composer.container
        .querySelector('[aria-label="Send"]')
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
    assert.equal(composer.sent.length, 1);
    assert.equal(
      composer.sent[0].content,
      "Email support@example.com about @scope/package.",
    );
    assert.deepEqual(composer.sent[0].mentionPubkeys, []);
  } finally {
    await composer.unmount();
  }
});

// The channel main composer no longer takes a threadRef at all (Sam
// 2026-09-20): with a thread open in the right pane, typing HERE must post
// TOP-LEVEL — the thread pane's own composer is the only one that targets the
// thread. Mutation guard: if the send payload carried anything but null (an
// undefined, or a leaked root ref), the wire would thread the message after
// all. `null` is asserted exactly — not `falsy` — so undefined fails too.
test("a composer with no threadRef prop posts top-level (threadRef null)", async () => {
  const composer = await mountComposer({ omitThreadProps: true });
  try {
    assert.ok(
      !composer.container.textContent.includes("Replying in thread"),
      "no thread hint renders without a threadRef",
    );
    const input = composer.container.querySelector(
      '[data-testid="composer-input"]',
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      ).set.call(input, "top-level channel message");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await flush();
    await act(async () => {
      composer.container
        .querySelector('[aria-label="Send"]')
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await flush();
    assert.equal(composer.sent.length, 1);
    assert.equal(
      composer.sent[0].threadRef,
      null,
      "the payload carries threadRef null, not undefined, not a root",
    );
  } finally {
    await composer.unmount();
  }
});

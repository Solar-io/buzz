import assert from "node:assert/strict";
import { test, after } from "node:test";

// Slash commands in the REAL Composer under jsdom + act (the Composer.test.mjs
// harness). What this file pins is the Phase 2 rule the pure suites cannot
// reach: a command line typed into the box NEVER arrives at `send` — not a
// known command, not an unknown one, not in a box that cannot run commands.
// `send` is a recording fake, so "never sent" is an assertion on its calls,
// not on a string the component happens to render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
  pretendToBeVisual: true,
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  toasts: globalThis.__BUZZ_TEST_TOASTS__,
};
const globalKeysBefore = new Set(Object.getOwnPropertyNames(globalThis));
const FORCE_JSDOM = new Set([
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
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SELF = "a".repeat(64);
const NIKON = "b".repeat(64);
const CHANNEL = "chan-flight-path";

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
globalThis.__BUZZ_TEST_REACT__ = React;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/blossom": `
    export async function uploadBlob() {
      throw new Error("no uploads in this suite");
    }
  `,
  "@/shared/lib/useOwnPubkey": `
    export function useOwnPubkey() {
      return "${SELF}";
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
    const push = (kind) => (message) =>
      globalThis.__BUZZ_TEST_TOASTS__?.push(kind + ":" + String(message));
    export const toast = {
      error: push("error"),
      message: push("message"),
      success: push("success"),
      custom: push("custom"),
    };
  `,
};

const { Composer } = await import("./Composer.tsx");

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
  globalThis.__BUZZ_TEST_TOASTS__ = originals.toasts;
});

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** A recording command host: what the route hands the main composer. */
function host() {
  const calls = { reminders: [], work: [] };
  return {
    calls,
    value: {
      channel: { id: CHANNEL, name: "flight-path", type: "stream" },
      messages: [
        {
          id: "ask-1",
          channelId: CHANNEL,
          authorPubkey: NIKON,
          createdAt: 100,
          content: "Trim the hold to 1.5s?",
          kind: 9,
          mentionPubkeys: [SELF],
        },
      ],
      createReminder: async (input) => {
        calls.reminders.push(input);
      },
      openWorkForChannel: (id) => {
        calls.work.push(id);
      },
    },
  };
}

async function mount(props = {}) {
  globalThis.__BUZZ_TEST_TOASTS__ = [];
  const sent = [];
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(Composer, {
        members: [
          { pubkey: SELF, name: "Sam" },
          { pubkey: NIKON, name: "Lord Nikon" },
        ],
        profiles: new Map([
          [SELF, { displayName: "Sam" }],
          [NIKON, { displayName: "Lord Nikon" }],
        ]),
        send: async (payload) => {
          sent.push(payload);
          return { ok: true, message: "" };
        },
        ...props,
      }),
    );
  });
  await flush();
  const input = () => container.querySelector('[data-testid="composer-input"]');
  return {
    container,
    sent,
    input,
    error: () =>
      container.querySelector('[data-testid="composer-command-error"]')
        ?.textContent ?? null,
    options: () =>
      [...container.querySelectorAll('[data-testid^="command-option-"]')].map(
        (row) => row.getAttribute("data-testid").replace("command-option-", ""),
      ),
    type: async (text) => {
      const el = input();
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        ).set.call(el, text);
        el.setSelectionRange(text.length, text.length);
        el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await flush();
    },
    key: async (key) => {
      await act(async () => {
        input().dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await flush();
    },
    clickSend: async () => {
      await act(async () => {
        container
          .querySelector('[aria-label="Send"]')
          .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
      await flush();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a command is never passed to send", async () => {
  const commands = host();
  const composer = await mount({ commands: commands.value });
  try {
    // A known command, typed in full and sent with the button.
    await composer.type("/status");
    await composer.clickSend();
    assert.deepEqual(commands.calls.work, [CHANNEL], "/status ran");
    assert.deepEqual(composer.sent, [], "/status was not sent as text");
    assert.equal(
      composer.input().value,
      "",
      "a command that ran clears the box",
    );

    // A command with arguments, sent with Enter (the list is closed by then).
    await composer.type("/remind 2h");
    await composer.key("Enter");
    assert.equal(commands.calls.reminders.length, 1, "/remind ran");
    assert.equal(commands.calls.reminders[0].target.eventId, "ask-1");
    assert.deepEqual(composer.sent, [], "/remind was not sent as text");
    assert.ok(
      (globalThis.__BUZZ_TEST_TOASTS__ ?? []).some((line) =>
        line.startsWith("success:Reminder set for"),
      ),
      "the command's notice is toasted",
    );
  } finally {
    await composer.unmount();
  }
});

test("an unknown command shows an inline error, keeps the draft and sends nothing", async () => {
  const commands = host();
  const composer = await mount({ commands: commands.value });
  try {
    await composer.type("/remnid 2h");
    await composer.clickSend();
    assert.deepEqual(
      composer.sent,
      [],
      "a typo'd command never reaches the wire",
    );
    assert.deepEqual(commands.calls.reminders, []);
    assert.equal(
      composer.error(),
      "Unknown command /remnid — not sent. Start with a space to send it as text.",
    );
    assert.equal(composer.input().value, "/remnid 2h", "the draft is kept");

    // Editing the draft clears the error.
    await composer.type("/remind 2h");
    assert.equal(composer.error(), null);

    // A later-phase command is unknown too: it must not post "/new scratch".
    await composer.type("/new scratch");
    await composer.key("Enter");
    assert.deepEqual(composer.sent, []);
    assert.match(composer.error() ?? "", /^Unknown command \/new/);
  } finally {
    await composer.unmount();
  }
});

test("a command's own refusal is shown inline and nothing is sent", async () => {
  const commands = host();
  const composer = await mount({ commands: commands.value });
  try {
    await composer.type("/handoff @Nobody capture pass");
    await composer.key("Enter");
    assert.deepEqual(composer.sent, []);
    assert.match(composer.error() ?? "", /isn't one member of this channel/);
    assert.equal(composer.input().value, "/handoff @Nobody capture pass");
  } finally {
    await composer.unmount();
  }
});

test("/handoff sends ONE message through the composer's send: the task, never the slash", async () => {
  const commands = host();
  const composer = await mount({ commands: commands.value });
  try {
    await composer.type("/handoff @Lord Nikon final capture pass");
    await composer.key("Enter");
    assert.deepEqual(composer.sent, [
      {
        content: "@Lord Nikon final capture pass",
        mentionPubkeys: [NIKON],
        threadRef: null,
        mediaTags: [["handoff", NIKON]],
      },
    ]);
    assert.equal(composer.input().value, "");
  } finally {
    await composer.unmount();
  }
});

test("a leading space or a path sends as text; so does a slash line in a box with no commands", async () => {
  const commands = host();
  const composer = await mount({ commands: commands.value });
  try {
    await composer.type(" /status");
    await composer.clickSend();
    await composer.type("/usr/local/bin is missing");
    await composer.clickSend();
    assert.deepEqual(
      composer.sent.map((payload) => payload.content),
      ["/status", "/usr/local/bin is missing"],
    );
    assert.deepEqual(
      commands.calls.work,
      [],
      "the escaped /status did not run",
    );
  } finally {
    await composer.unmount();
  }

  // Forum and huddle composers pass no `commands`: their text is untouched.
  const plain = await mount();
  try {
    await plain.type("/status");
    await plain.clickSend();
    assert.deepEqual(
      plain.sent.map((payload) => payload.content),
      ["/status"],
    );
  } finally {
    await plain.unmount();
  }
});

test("a thread reply box refuses a slash line instead of posting it", async () => {
  const composer = await mount({
    commands: "elsewhere",
    threadRef: { rootId: "root-1", replyToId: "root-1" },
    variant: "inline",
  });
  try {
    await composer.type("/status");
    await composer.key("Enter");
    assert.deepEqual(composer.sent, []);
    assert.equal(
      composer.error(),
      "Commands run from the channel's message box — nothing was sent.",
    );
    // An ordinary reply still threads.
    await composer.type("Keep the cursor move slow.");
    await composer.key("Enter");
    assert.deepEqual(
      composer.sent.map((payload) => [payload.content, payload.threadRef]),
      [
        [
          "Keep the cursor move slow.",
          { rootId: "root-1", replyToId: "root-1" },
        ],
      ],
    );
  } finally {
    await composer.unmount();
  }
});

test("the list filters as you type; Tab completes, Enter runs, Esc closes", async () => {
  const commands = host();
  const composer = await mount({ commands: commands.value });
  try {
    await composer.type("/");
    assert.deepEqual(composer.options(), ["remind", "handoff", "status"]);
    await composer.type("/s");
    assert.deepEqual(composer.options(), ["status"]);

    // Enter on a command that runs bare: it runs, and nothing is sent.
    await composer.key("Enter");
    assert.deepEqual(commands.calls.work, [CHANNEL]);
    assert.deepEqual(composer.sent, []);

    // Tab completes the name and leaves the caret after it.
    await composer.type("/ha");
    await composer.key("Tab");
    assert.equal(composer.input().value, "/handoff ");
    assert.deepEqual(composer.options(), [], "arguments started: list closed");

    // Enter on a command that NEEDS arguments completes instead of running.
    await composer.type("/ha");
    await composer.key("Enter");
    assert.equal(composer.input().value, "/handoff ");
    assert.deepEqual(composer.sent, []);

    // Esc closes the list until the text changes.
    await composer.type("/re");
    assert.deepEqual(composer.options(), ["remind"]);
    await composer.key("Escape");
    assert.deepEqual(composer.options(), []);
    await composer.type("/rem");
    assert.deepEqual(composer.options(), ["remind"]);
  } finally {
    await composer.unmount();
  }
});

test("a key typed right after picking a mention lands after the name", async () => {
  // Frames are held so the order is the race QA hit: the pick, then a key,
  // THEN the frame the old caret move waited for.
  const frames = [];
  const realFrame = dom.window.requestAnimationFrame;
  dom.window.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  const composer = await mount();
  try {
    await composer.type("hi @Lo");
    await composer.key("Enter");
    assert.equal(composer.input().value, "hi @Lord Nikon ");
    await composer.type("hi @Lord Nikon r");
    await act(async () => {
      for (const callback of frames.splice(0)) {
        callback(0);
      }
    });
    const el = composer.input();
    assert.equal(el.value, "hi @Lord Nikon r");
    assert.equal(
      el.selectionStart,
      el.value.length,
      "the caret stays after the typed key; a late frame moved it back",
    );
  } finally {
    dom.window.requestAnimationFrame = realFrame;
    await composer.unmount();
  }
});

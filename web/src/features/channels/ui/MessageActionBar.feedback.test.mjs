import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

/**
 * The hover bar's Feedback button, driven through the REAL MessageActionBar,
 * the REAL RemindMeLaterProvider, and the REAL `useReminderMutations` hook on
 * a real TanStack QueryClient. Only the boundaries are faked: the relay
 * session (so no socket), `createReminder` (so no crypto — it records its
 * arguments and returns a promise the test settles), the toast, and the
 * dialog.
 *
 * What this pins: one click reaches the dialog's `createReminder` path with
 * due = TOMORROW 9:00 AM LOCAL and the message as target (web redesign
 * Phase 2; the button this replaced filed +24 h); the reminders query is
 * invalidated on success (Work / nav badge); a second click while the first
 * is in flight is dropped; success and failure both toast.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
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

const state = { creates: [], toasts: [] };
globalThis.__FEEDBACK_TEST__ = state;

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  ...(originals.stubs ?? {}),
  "@/shared/api/RelaySessionProvider": `
    const session = { subscribe: () => () => {}, publish: async () => ({ ok: true }) };
    export function useRelaySession() { return { session, status: "closed" }; }
  `,
  // hooks.ts's own specifier for the service — the dialog's create path.
  "./lib/reminderService.ts": `
    const s = () => globalThis.__FEEDBACK_TEST__;
    export function createReminder(session, selfPubkey, input) {
      return new Promise((resolve, reject) =>
        s().creates.push({ selfPubkey, input, resolve, reject }));
    }
    const never = () => new Promise(() => {});
    export const fetchReminders = never;
    export const snoozeReminder = never;
    export const completeReminder = never;
    export const cancelReminder = never;
  `,
  sonner: `
    const s = () => globalThis.__FEEDBACK_TEST__;
    export const toast = {
      success: (m) => s().toasts.push({ kind: "success", m }),
      error: (m) => s().toasts.push({ kind: "error", m }),
    };
  `,
  "./RemindMeLaterDialog.tsx": `
    export function RemindMeLaterDialog() { return null; }
  `,
};

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.HTMLElement = originals.HTMLElement;
  globalThis.Node = originals.Node;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  delete globalThis.__FEEDBACK_TEST__;
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { RemindMeLaterProvider } = await import(
  "@/features/reminders/ui/RemindMeLaterProvider"
);
const { MessageActionBar } = await import("./MessageActionBar.tsx");

const SELF = "1".repeat(64);
const AUTHOR = "2".repeat(64);
// Local wall-clock instants, so the expectation is a hardcoded calendar time
// in any timezone: clicked Wed 30 Sep 2026 at 3:42 PM, due Thu 1 Oct at 9:00.
const CLICK_MS = new Date(2026, 8, 30, 15, 42, 0, 0).getTime();
const DUE_S = new Date(2026, 9, 1, 9, 0, 0, 0).getTime() / 1000;

async function mount() {
  const queryClient = new QueryClient({
    // gcTime 0: no five-minute cache timers holding the runner open.
    defaultOptions: {
      mutations: { retry: false, gcTime: 0 },
      queries: { gcTime: 0 },
    },
  });
  const invalidated = [];
  const realInvalidate = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = (filters) => {
    invalidated.push(filters?.queryKey);
    return realInvalidate(filters);
  };
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          RemindMeLaterProvider,
          { selfPubkey: SELF },
          React.createElement(MessageActionBar, {
            messageId: "msg-1",
            channelId: "chan-1",
            authorPubkey: AUTHOR,
            messagePreview: "ship the thing",
          }),
        ),
      ),
    );
  });
  let mounted = true;
  const view = {
    invalidated,
    button: () =>
      container.querySelector('[data-testid="feedback-message-msg-1"]'),
    unmount: async () => {
      if (!mounted) {
        return;
      }
      mounted = false;
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    },
  };
  live.add(view);
  return view;
}

// A test that fails mid-way must not leak its tree or a never-settled create
// into the next one (that turns one real failure into several, or hangs the
// runner on an unresolved promise).
const live = new Set();
afterEach(async () => {
  for (const pending of state.creates) {
    pending.resolve({});
  }
  for (const view of live) {
    await view.unmount();
  }
  live.clear();
});

function reset() {
  state.creates.length = 0;
  state.toasts.length = 0;
}

async function clickAt(button, nowMs, times = 1) {
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    await act(async () => {
      for (let i = 0; i < times; i += 1) {
        button.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      }
      await drain();
    });
  } finally {
    Date.now = realNow;
  }
}

/**
 * TanStack's notifyManager batches observer updates on setTimeout(0), and a
 * settling mutation awaits several callbacks before it schedules one — so a
 * single tick can run BEFORE the notify is queued (a real flake, seen 1 in 8).
 * A few macrotask turns let the whole chain land before assertions.
 */
async function drain() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function settle(fn) {
  await act(async () => {
    fn();
    await drain();
  });
}

test("Feedback is labelled and titled, and rendered with no author gate", async () => {
  reset();
  const view = await mount();
  const button = view.button();
  assert.ok(button, "Feedback button rendered");
  assert.equal(button.getAttribute("aria-label"), "Send to Feedback");
  assert.equal(
    button.getAttribute("title"),
    "Send to Feedback: reply later, with an AI summary",
  );
  assert.match(button.textContent, /Feedback/);
  assert.equal(button.disabled, false);
  await view.unmount();
});

test("one click creates the reminder due tomorrow 9:00 AM with the message target", async () => {
  reset();
  const view = await mount();
  await clickAt(view.button(), CLICK_MS);
  assert.equal(state.creates.length, 1);
  const [call] = state.creates;
  assert.equal(call.selfPubkey, SELF);
  assert.deepEqual(call.input, {
    target: {
      eventId: "msg-1",
      channelId: "chan-1",
      preview: "ship the thing",
      authorPubkey: AUTHOR,
    },
    // NOT click + 86 400 s (3:42 PM tomorrow): the start of the next day.
    notBefore: DUE_S,
  });
  assert.notEqual(DUE_S, CLICK_MS / 1000 + 86_400);
  await settle(() => call.resolve({}));
  await view.unmount();
});

test("success invalidates the reminders query and toasts 'Sent to Feedback'", async () => {
  reset();
  const view = await mount();
  await clickAt(view.button(), CLICK_MS);
  await settle(() => state.creates[0].resolve({}));
  assert.deepEqual(view.invalidated, [["reminders", SELF]]);
  assert.equal(state.toasts.length, 1);
  assert.equal(state.toasts[0].kind, "success");
  assert.match(state.toasts[0].m, /^Sent to Feedback · due tomorrow 9:00/);
  await view.unmount();
});

test("the button disables while in flight and a double-click is dropped", async () => {
  reset();
  const view = await mount();
  // Two clicks in ONE tick: the button cannot have disabled yet, so this is
  // the in-flight ref's job alone.
  await clickAt(view.button(), CLICK_MS, 2);
  assert.equal(state.creates.length, 1);
  assert.equal(view.button().disabled, true);
  // And a later click on the now-disabled button is inert too.
  await clickAt(view.button(), CLICK_MS);
  assert.equal(state.creates.length, 1);
  await settle(() => state.creates[0].resolve({}));
  assert.equal(view.button().disabled, false);
  // Once settled, the next click goes through again.
  await clickAt(view.button(), CLICK_MS);
  assert.equal(state.creates.length, 2);
  await settle(() => state.creates[1].resolve({}));
  await view.unmount();
});

test("failure toasts the error message, as the dialog does", async () => {
  reset();
  const view = await mount();
  await clickAt(view.button(), CLICK_MS);
  await settle(() =>
    state.creates[0].reject(new Error("Reminders need the unlocked key")),
  );
  assert.deepEqual(state.toasts, [
    { kind: "error", m: "Reminders need the unlocked key" },
  ]);
  assert.deepEqual(view.invalidated, []);
  await view.unmount();
});

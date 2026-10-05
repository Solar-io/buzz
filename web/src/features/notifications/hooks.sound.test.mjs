import assert from "node:assert/strict";
import { after, test } from "node:test";

// Caller-level: mount the REAL useNotificationRuntime under jsdom, feed it
// relay events through a stubbed session, and watch what it does with
// `Audio` and `Notification`. The pure decision is pinned in
// notifyDecision.test.mjs; this pins that the runtime actually plays the
// sound it decided on, silences a muted channel, keeps the muted channel in
// the subscription, and builds the OS notification with `silent: true`.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
  pretendToBeVisual: true,
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  Audio: globalThis.Audio,
  Notification: globalThis.Notification,
  session: globalThis.__BUZZ_TEST_NOTIFY_SESSION__,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: dom.window.localStorage,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const played = [];
globalThis.Audio = class {
  constructor(src) {
    this.src = src;
    this.currentTime = 0;
  }
  play() {
    played.push(this.src);
    return Promise.resolve();
  }
};
const notifications = [];
globalThis.Notification = class {
  static permission = "granted";
  static requestPermission() {
    return Promise.resolve("granted");
  }
  constructor(title, options) {
    notifications.push({ title, options });
  }
  close() {}
};

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);
const LOUD = "11111111-1111-4111-8111-111111111111";
const MUTED = "22222222-2222-4222-8222-222222222222";
const DM = "33333333-3333-4333-8333-333333333333";

// Stored settings are read once, on first access to the module store.
dom.window.localStorage.setItem(
  "buzz.notifications.v1",
  JSON.stringify({ desktopEnabled: true, mode: "all" }),
);
dom.window.localStorage.setItem(
  "buzz.channel-prefs.v1",
  JSON.stringify({ favorites: [], muted: [MUTED] }),
);

const subscriptions = [];
globalThis.__BUZZ_TEST_NOTIFY_SESSION__ = {
  subscribe(filter, handlers) {
    subscriptions.push({ filter, handlers });
    return () => {};
  },
};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_NOTIFY_SESSION__ };
    }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNotificationRuntime } = await import("./hooks.ts");
const { updateNotificationSettings } = await import("./lib/settingsStore.ts");

const channels = [
  { id: LOUD, name: "loud", type: "stream", archived: false },
  { id: MUTED, name: "quiet", type: "stream", archived: false },
  { id: DM, name: "dm", type: "dm", archived: false },
];

function Harness() {
  useNotificationRuntime({
    selfPubkey: SELF,
    // A visible tab on some OTHER channel: sound must still play.
    activeChannelId: "elsewhere",
    channels,
  });
  return null;
}

const container = dom.window.document.createElement("div");
dom.window.document.body.appendChild(container);
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(Harness));
});

after(async () => {
  await act(async () => {
    root.unmount();
  });
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  if (originals.localStorage) {
    Object.defineProperty(globalThis, "localStorage", originals.localStorage);
  } else {
    delete globalThis.localStorage;
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.Audio = originals.Audio;
  globalThis.Notification = originals.Notification;
  globalThis.__BUZZ_TEST_NOTIFY_SESSION__ = originals.session;
});

let seq = 0;
async function deliver(channelId, { mention = false } = {}) {
  seq += 1;
  const event = {
    id: `evt-${seq}`.padEnd(64, "0"),
    kind: 9,
    pubkey: OTHER,
    content: `hello ${seq}`,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", channelId], ...(mention ? [["p", SELF]] : [])],
    sig: "",
  };
  played.length = 0;
  notifications.length = 0;
  assert.ok(subscriptions.length > 0, "runtime never subscribed");
  await act(async () => {
    subscriptions[subscriptions.length - 1].handlers.onEvent(event);
  });
}

test("the muted channel is still in the subscription (mute ≠ unsubscribed)", () => {
  const ids = subscriptions.flatMap((sub) => sub.filter["#h"] ?? []);
  assert.ok(ids.includes(MUTED), `muted channel missing from REQ: ${ids}`);
  assert.ok(ids.includes(LOUD));
});

test("runtime: an unmuted channel message plays the channel sound", async () => {
  await deliver(LOUD);
  assert.deepEqual(played, ["/assets/sounds/doop.mp3"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.silent, true);
});

test("runtime: a muted channel notifies but plays NO sound", async () => {
  await deliver(MUTED, { mention: true });
  assert.deepEqual(played, []);
  assert.equal(notifications.length, 1, "muted channel must still notify");
});

test("runtime: a mention plays the mention sound, a DM the dm sound", async () => {
  await deliver(LOUD, { mention: true });
  assert.deepEqual(played, ["/assets/sounds/ping.mp3"]);
  await deliver(DM, { mention: true });
  assert.deepEqual(played, ["/assets/sounds/unison.mp3"]);
});

test("runtime: sound still plays with desktop notifications off", async () => {
  await act(async () => {
    updateNotificationSettings({ desktopEnabled: false });
  });
  await deliver(LOUD);
  assert.deepEqual(played, ["/assets/sounds/doop.mp3"]);
  assert.equal(notifications.length, 0);
  await act(async () => {
    updateNotificationSettings({ desktopEnabled: true });
  });
});

test("runtime: soundEnabled off plays nothing", async () => {
  await act(async () => {
    updateNotificationSettings({ soundEnabled: false });
  });
  await deliver(LOUD);
  assert.deepEqual(played, []);
  assert.equal(notifications.length, 1);
  await act(async () => {
    updateNotificationSettings({ soundEnabled: true });
  });
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

// Caller-level guard for "mute just means no sound": renders the real hooks and
// counts Audio.play() calls. Banners still fire; sound must not for muted ids.

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const plays = [];
class FakeAudio {
  constructor(src) {
    this.src = src;
    this.currentTime = 0;
  }
  play() {
    plays.push(this.src);
    return Promise.resolve();
  }
}
const banners = [];
class FakeNotification {
  static permission = "granted";
  constructor(title) {
    banners.push(title);
  }
}

before(() => {
  dom.window.Notification = FakeNotification;
  Object.assign(globalThis, {
    Audio: FakeAudio,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
});

after(() => dom.window.close());

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const settings = {
  desktopEnabled: true,
  homeBadgeEnabled: true,
  notifyWhileViewing: false,
  sounds: {},
  slotAlertsEnabled: {
    dm: true,
    thread_reply: true,
    mention: true,
    needs_action: true,
  },
  slotAlertsSnapshot: null,
};

async function realSettings() {
  const { DEFAULT_SLOT_SOUNDS, DEFAULT_SLOT_ALERTS_ENABLED } = await import(
    "./lib/sound.ts"
  );
  return {
    ...settings,
    sounds: { ...DEFAULT_SLOT_SOUNDS },
    slotAlertsEnabled: { ...DEFAULT_SLOT_ALERTS_ENABLED },
  };
}

const event = (channelTag) => ({
  id: "ev1",
  kind: 9,
  pubkey: "a".repeat(64),
  created_at: 1,
  content: "hi",
  tags: [["h", channelTag]],
  sig: "",
});

for (const [name, run] of [
  [
    "DM path",
    async ({ result }, ch) => {
      result.current.handleDmNotification(event(ch), {
        id: ch,
        name: "dm",
        channelType: "dm",
      });
    },
  ],
  [
    "thread-reply path",
    async ({ result }, ch) => {
      result.current.handleThreadReplyDesktopNotification(ch, event(ch));
    },
  ],
]) {
  test(`AppShell hook ${name}: muted channel banners but never plays sound`, async () => {
    const { renderHook, cleanup } = await import("@testing-library/react");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const React = await import("react");
    const { CommunitiesProvider } = await import(
      "@/features/communities/useCommunities.tsx"
    );
    const { useAppShellDesktopNotifications } = await import(
      "@/app/useAppShellDesktopNotifications.ts"
    );
    const { relayClient } = await import("@/shared/api/relayClient");
    relayClient.fetchEvents = async () => [];
    relayClient.subscribeLive = async () => async () => {};
    relayClient.subscribeToReconnects = () => () => {};
    const notif = await realSettings();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }) =>
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(CommunitiesProvider, null, children),
      );
    const render = (muted) =>
      renderHook(
        () =>
          useAppShellDesktopNotifications({
            channels: [{ id: "c-muted", name: "x" }],
            enabled: true,
            goChannel: async () => {},
            goHome: async () => {},
            notificationSettings: notif,
            openSearchHit: async () => {},
            pubkey: "b".repeat(64),
            mutedChannelIds: muted,
          }),
        { wrapper },
      );
    try {
      // control: unmuted plays a sound (proves harness can observe sound)
      plays.length = 0;
      banners.length = 0;
      let h = render(new Set());
      await run(h, "c-muted");
      await flush();
      assert.equal(plays.length, 1, "control: unmuted must play a sound");
      h.unmount();

      plays.length = 0;
      banners.length = 0;
      h = render(new Set(["c-muted"]));
      await run(h, "c-muted");
      await flush();
      assert.ok(banners.length >= 1, "muted still shows a banner");
      assert.equal(plays.length, 0, "muted must not play a sound");
    } finally {
      cleanup();
      qc.clear();
    }
  });
}

test("feed hook: muted channel mention banners but never plays sound", async () => {
  const { renderHook, cleanup } = await import("@testing-library/react");
  const { useFeedDesktopNotifications } = await import(
    "./use-feed-desktop-notifications.ts"
  );
  const notif = await realSettings();
  const mention = {
    id: "m1",
    kind: 9,
    pubkey: "a".repeat(64),
    content: "hey",
    createdAt: 5,
    channelId: "c-muted",
    channelName: "x",
    tags: [],
    category: "mention",
  };
  const mk = (items) => ({
    feed: { mentions: items, needsAction: [], activity: [], agentActivity: [] },
    meta: { since: 0, total: 0, generatedAt: 0 },
  });
  const run = async (muted) => {
    plays.length = 0;
    banners.length = 0;
    window.localStorage.clear();
    const h = renderHook(
      ({ feed }) =>
        useFeedDesktopNotifications(
          feed,
          "b".repeat(64),
          notif,
          async () => true,
          true,
          {},
          muted,
          [],
          undefined,
        ),
      { initialProps: { feed: mk([]) } },
    );
    await flush();
    h.rerender({ feed: mk([mention]) });
    await flush();
    h.unmount();
  };
  try {
    await run(new Set());
    assert.equal(plays.length, 1, "control: unmuted mention plays a sound");
    await run(new Set(["c-muted"]));
    assert.ok(banners.length >= 1, "muted mention still banners");
    assert.equal(plays.length, 0, "muted mention must not play a sound");
  } finally {
    cleanup();
  }
});

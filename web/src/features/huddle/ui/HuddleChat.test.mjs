import assert from "node:assert/strict";
import { test, after } from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/repos/",
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

const ROOM = "temporary-room";
const WRONG_ROOM = "another-room";
const HUMAN = "1".repeat(64);
const AGENT = "2".repeat(64);
const SILENT_MEMBER = "3".repeat(64);

globalThis.__BUZZ_TEST_HUDDLE_SESSION__ = {
  call: {
    channelId: ROOM,
    selfPubkey: HUMAN,
    send: () => {},
    memberPubkeys: [HUMAN, AGENT],
  },
};
globalThis.__BUZZ_TEST_HUDDLE_FEED__ = {
  messages: [],
  reactions: new Map(),
  loadOlder: () => {},
  loadingOlder: false,
  historyExhausted: true,
};

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../HuddleSessionProvider.tsx": `
    export function useHuddleSession() {
      return globalThis.__BUZZ_TEST_HUDDLE_SESSION__;
    }
  `,
  "@/features/channels/hooks": `
    export function useChannelMessages() {
      return globalThis.__BUZZ_TEST_HUDDLE_FEED__;
    }
    export function useChannelMembers() { return []; }
    export function useProfiles(pubkeys) {
      globalThis.__BUZZ_TEST_HUDDLE_PROFILE_KEYS__ = pubkeys;
      return new Map(pubkeys.map((pubkey) => [pubkey, {
        name: pubkey.slice(0, 8), displayName: pubkey.slice(0, 8),
      }]));
    }
  `,
  "@/features/channels/ui/ChannelTimeline": `
    export function ChannelTimeline({ messages, showActions, flat }) {
      const React = globalThis.__BUZZ_TEST_REACT__;
      return React.createElement("div", {
        "data-testid": "huddle-chat-timeline",
        "data-show-actions": String(showActions),
        "data-flat": String(flat),
      }, messages.map((message) => React.createElement("div", {
        key: message.id,
        "data-testid": "message-row-" + message.id,
      }, message.content)));
    }
  `,
  "@/features/channels/ui/Composer": `
    export function Composer(props) {
      globalThis.__BUZZ_TEST_HUDDLE_COMPOSER_PROPS__ = props;
      return null;
    }
  `,
};

const React = (await import("react")).default;
globalThis.__BUZZ_TEST_REACT__ = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HuddleChat } = await import("./HuddleChat.tsx");

function message(
  id,
  channelId,
  authorPubkey,
  content,
  kind = 9,
  deleted = false,
) {
  return { id, channelId, authorPubkey, content, kind, deleted };
}

async function mount(messages, variant = "compact") {
  globalThis.__BUZZ_TEST_HUDDLE_FEED__.messages = messages;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HuddleChat, { variant }));
  });
  return {
    container,
    rerender: async () => {
      await act(async () => {
        root.render(React.createElement(HuddleChat, { variant }));
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("compact call chat renders both completed sides read-only in the exact room", async () => {
  const mounted = await mount([
    message("human", ROOM, HUMAN, "what did you find?"),
    message("agent", ROOM, AGENT, "I found the missing transcript."),
    message("wrong", WRONG_ROOM, AGENT, "must never appear"),
    message("deleted", ROOM, AGENT, "deleted", 9, true),
  ]);

  const chat = mounted.container.querySelector('[data-testid="huddle-chat"]');
  assert.ok(chat?.classList.contains("flex"));
  assert.ok(
    mounted.container
      .querySelector('[data-testid="huddle-chat-timeline"]')
      ?.parentElement?.classList.contains("flex"),
  );

  assert.equal(
    mounted.container.querySelector('[data-testid="message-row-human"]')
      .textContent,
    "what did you find?",
  );
  assert.equal(
    mounted.container.querySelector('[data-testid="message-row-agent"]')
      .textContent,
    "I found the missing transcript.",
  );
  assert.equal(
    mounted.container.querySelector('[data-testid="message-row-wrong"]'),
    null,
  );
  assert.equal(
    mounted.container.querySelector('[data-testid="message-row-deleted"]'),
    null,
  );
  assert.equal(
    mounted.container.querySelector('[data-testid="huddle-chat-timeline"]')
      .dataset.showActions,
    "false",
  );
  assert.equal(
    mounted.container.querySelector('[data-testid="huddle-chat-timeline"]')
      .dataset.flat,
    "true",
  );
  await mounted.unmount();
});

test("wrong-room mutation remains excluded from the transcript", async () => {
  const mounted = await mount([
    message("wrong-only", WRONG_ROOM, AGENT, "wrong room payload"),
  ]);
  assert.equal(
    mounted.container.querySelector('[data-testid="message-row-wrong-only"]'),
    null,
  );
  await mounted.unmount();
});

test("switching rooms cannot reuse an old feed array", async () => {
  const oldFeed = [message("old", ROOM, HUMAN, "old room text")];
  const mounted = await mount(oldFeed);
  assert.ok(mounted.container.querySelector('[data-testid="message-row-old"]'));

  // Keep the same feed array reference while the call room changes. The
  // channel id dependency must still invalidate the compact filter.
  globalThis.__BUZZ_TEST_HUDDLE_SESSION__.call.channelId = WRONG_ROOM;
  await mounted.rerender();
  assert.equal(
    mounted.container.querySelector('[data-testid="message-row-old"]'),
    null,
  );
  await mounted.unmount();
});

test("full huddle chat uses silent roster members and requests their profiles", async () => {
  const previousRoster =
    globalThis.__BUZZ_TEST_HUDDLE_SESSION__.call.memberPubkeys;
  globalThis.__BUZZ_TEST_HUDDLE_SESSION__.call.memberPubkeys = [
    HUMAN,
    SILENT_MEMBER,
  ];
  globalThis.__BUZZ_TEST_HUDDLE_COMPOSER_PROPS__ = null;
  globalThis.__BUZZ_TEST_HUDDLE_PROFILE_KEYS__ = [];
  const mounted = await mount(
    [message("human-only", ROOM, HUMAN, "hello")],
    "full",
  );
  try {
    const props = globalThis.__BUZZ_TEST_HUDDLE_COMPOSER_PROPS__;
    assert.deepEqual(
      props.members.map((member) => member.pubkey),
      [HUMAN, SILENT_MEMBER],
      "a silent member remains mentionable",
    );
    assert.equal(props.strictMentions, true);
    assert.deepEqual(globalThis.__BUZZ_TEST_HUDDLE_PROFILE_KEYS__, [
      HUMAN,
      SILENT_MEMBER,
    ]);
  } finally {
    await mounted.unmount();
    globalThis.__BUZZ_TEST_HUDDLE_SESSION__.call.memberPubkeys = previousRoster;
  }
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

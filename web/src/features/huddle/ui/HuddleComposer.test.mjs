import assert from "node:assert/strict";
import { test, after } from "node:test";

// The floating huddle's composer, mounted for real under jsdom + act.
// It replaced the panel's "Call transcript" timeline (Sam, 2026-10-01): the
// relay mirrors every call line into the parent chat, so the panel keeps
// only the way to type into the call.

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
const HUMAN = "1".repeat(64);
const SILENT_MEMBER = "3".repeat(64);

globalThis.__BUZZ_TEST_HUDDLE_SESSION__ = {
  call: {
    channelId: ROOM,
    selfPubkey: HUMAN,
    send: () => {},
    memberPubkeys: [HUMAN, SILENT_MEMBER],
  },
};

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "../HuddleSessionProvider.tsx": `
    export function useHuddleSession() {
      return globalThis.__BUZZ_TEST_HUDDLE_SESSION__;
    }
  `,
  "@/features/channels/hooks": `
    export function useProfiles(pubkeys) {
      globalThis.__BUZZ_TEST_HUDDLE_PROFILE_KEYS__ = pubkeys;
      return new Map(pubkeys.map((pubkey) => [pubkey, {
        name: pubkey.slice(0, 8), displayName: pubkey.slice(0, 8),
      }]));
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
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HuddleComposer } = await import("./HuddleComposer.tsx");

async function mount() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(HuddleComposer));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the huddle composer posts to the call room and can mention silent members", async () => {
  globalThis.__BUZZ_TEST_HUDDLE_COMPOSER_PROPS__ = null;
  globalThis.__BUZZ_TEST_HUDDLE_PROFILE_KEYS__ = [];
  const mounted = await mount();
  try {
    assert.ok(
      mounted.container.querySelector('[data-testid="huddle-composer"]'),
    );
    const props = globalThis.__BUZZ_TEST_HUDDLE_COMPOSER_PROPS__;
    assert.equal(props.draftKey, ROOM);
    assert.equal(props.send, globalThis.__BUZZ_TEST_HUDDLE_SESSION__.call.send);
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
  }
});

test("no call room, no composer", async () => {
  const call = globalThis.__BUZZ_TEST_HUDDLE_SESSION__.call;
  call.channelId = null;
  const mounted = await mount();
  try {
    assert.equal(mounted.container.innerHTML, "");
  } finally {
    await mounted.unmount();
    call.channelId = ROOM;
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

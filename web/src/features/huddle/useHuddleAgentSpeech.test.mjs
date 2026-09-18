import assert from "node:assert/strict";
import { test, after } from "node:test";

// The SEAM WIRING test: does an agent's published kind-30182 selection
// actually reach the utterance? The assertion checks WHICH path spoke —
// disposition and profile source from the hook's `speakRoutes`, plus the
// voice object handed to the synthesizer — not merely that a voice was
// named. A green e2e once stayed green through a Korean-voice bug because
// a named voice was all it asserted (2026-09-16).
//
// The hook is mounted for real (jsdom + act, like VoicePickerList's test);
// the relay session boundary is stubbed at its exact import specifier, and
// `speechSynthesis` is faked on the jsdom window with fixture voices.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
  session: globalThis.__BUZZ_TEST_SESSION__,
  utteranceCtor: globalThis.SpeechSynthesisUtterance,
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

// FIXTURES: three local English voices; whatever a test asserts about
// "the derived voice" is computed through the real ranking + profile code.
const FIXTURE_VOICES = [
  {
    name: "Samantha",
    lang: "en-US",
    localService: true,
    voiceURI: "uri:samantha",
  },
  { name: "Ava", lang: "en-US", localService: true, voiceURI: "uri:ava" },
  { name: "Daniel", lang: "en-GB", localService: true, voiceURI: "uri:daniel" },
];

const spoken = [];
class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = undefined;
    this.voice = null;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
  }
}
dom.window.speechSynthesis = {
  getVoices: () => FIXTURE_VOICES,
  addEventListener: () => {},
  removeEventListener: () => {},
  cancel: () => {},
  speak(utterance) {
    spoken.push(utterance);
    // Settle on the onend path immediately, the way a healthy engine does —
    // the watchdog is a backstop this test never needs.
    queueMicrotask(() => utterance.onend?.());
  },
};
dom.window.SpeechSynthesisUtterance = FakeUtterance;
// The hook constructs `new SpeechSynthesisUtterance(...)` as a BARE global
// (the way a browser resolves it), so the fake must sit on globalThis too —
// a jsdom window does not inject its properties into node's globals.
globalThis.SpeechSynthesisUtterance = FakeUtterance;

// The relay session boundary, stubbed at its exact specifier: subscriptions
// are recorded so a test can deliver events to a chosen filter.
const subscriptions = [];
globalThis.__BUZZ_TEST_SESSION__ = {
  subscribe(filter, handlers) {
    subscriptions.push({ filter, handlers });
    return () => {};
  },
};
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: globalThis.__BUZZ_TEST_SESSION__ };
    }
  `,
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const { useHuddleAgentSpeech } = await import("./useHuddleAgentSpeech.ts");
const { rankVoices, speechVoiceProfile } = await import(
  "./lib/huddleAgentSpeech.ts"
);

const AGENT = "a".repeat(64);
const HUMAN = "c".repeat(64);
const CHANNEL = "eph-1";
const MESSAGE_ID = "e".repeat(64);

const snapshot = () => ({
  members: new Map([[AGENT, "bot"]]),
  known: true,
  merge: () => {},
});

function speechSelectionEvent(selection, overrides = {}) {
  return {
    pubkey: AGENT,
    created_at: 1_700_000_000,
    tags: [["d", "agent-voice"]],
    content: JSON.stringify({
      version: 1,
      label: "fixture",
      engine: selection.engine,
      ...(selection.engine === "pocket"
        ? { key: selection.key }
        : { voiceURI: selection.voiceURI }),
    }),
    ...overrides,
  };
}

function speakableMessage(overrides = {}) {
  return {
    id: MESSAGE_ID,
    kind: 40002,
    pubkey: AGENT,
    content: "Ready when you are.",
    tags: [["h", CHANNEL]],
    ...overrides,
  };
}

async function mountHook() {
  subscriptions.length = 0;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const captured = { current: null };
  function Harness() {
    captured.current = useHuddleAgentSpeech({
      channelId: CHANNEL,
      selfPubkey: HUMAN,
      audioPeerPubkeys: [],
      snapshot: snapshot(),
    });
    return null;
  }
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  return {
    captured,
    deliverSpeechSelection(selection) {
      const voiceSub = subscriptions.find((sub) =>
        sub.filter.kinds?.includes(30182),
      );
      assert.ok(voiceSub, "the hook must subscribe to kind 30182 selections");
      voiceSub.handlers.onEvent(speechSelectionEvent(selection));
    },
    deliverSpeakableMessage() {
      const speechSub = subscriptions.find((sub) => sub.filter["#h"]);
      assert.ok(speechSub, "the hook must subscribe to the speech filter");
      speechSub.handlers.onEvent(speakableMessage());
    },
    async flush() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function mountEnabledAndSpeak(selection) {
  spoken.length = 0; // tests assert exactly-one-utterance
  const harness = await mountHook();
  await act(async () => {
    harness.captured.current.setEnabled(true);
  });
  if (selection !== undefined) {
    harness.deliverSpeechSelection(selection);
  }
  await harness.flush();
  harness.deliverSpeakableMessage();
  await harness.flush();
  return harness;
}

test("wiring: a published local-synth selection speaks THAT voice, disposition selected", async () => {
  const harness = await mountEnabledAndSpeak({
    engine: "local-synth",
    voiceURI: "uri:samantha",
  });
  // THE wiring assertion: the utterance's voice IS the selected one.
  assert.equal(spoken.length, 1, "exactly one utterance was synthesized");
  assert.equal(spoken[0].voice?.voiceURI, "uri:samantha");
  // ...and the observable disposition says WHICH path spoke.
  const route = harness.captured.current.speakRoutes.current.get(AGENT);
  assert.ok(route, "the speak route must be recorded for the agent");
  assert.equal(route.disposition, "selected");
  assert.equal(route.profile.source, "selected");
  await harness.unmount();
});

test("wiring: no selection speaks the derived draw, disposition derived", async () => {
  const harness = await mountEnabledAndSpeak(undefined);
  const expected = speechVoiceProfile(AGENT, rankVoices(FIXTURE_VOICES));
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].voice?.voiceURI, expected.voiceURI);
  const route = harness.captured.current.speakRoutes.current.get(AGENT);
  assert.equal(route.disposition, "derived");
  assert.equal(route.profile.source, "derived");
  await harness.unmount();
});

test("wiring: a pocket selection synthesizes derived, disposition pocket-selected-pending-engine", async () => {
  const harness = await mountEnabledAndSpeak({
    engine: "pocket",
    key: "pocket:azelma",
  });
  const expected = speechVoiceProfile(AGENT, rankVoices(FIXTURE_VOICES));
  assert.equal(spoken.length, 1);
  // A browser cannot run pocket-tts: the UTTERANCE is the derived draw,
  // never a pocket-named voice.
  assert.equal(spoken[0].voice?.voiceURI, expected.voiceURI);
  const route = harness.captured.current.speakRoutes.current.get(AGENT);
  assert.equal(route.disposition, "pocket-selected-pending-engine");
  assert.equal(route.profile.source, "derived");
  await harness.unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    HTMLElement: originals.HTMLElement,
    Node: originals.Node,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    __BUZZ_TEST_SESSION__: originals.session,
  });
  if (originals.utteranceCtor === undefined) {
    delete globalThis.SpeechSynthesisUtterance;
  } else {
    globalThis.SpeechSynthesisUtterance = originals.utteranceCtor;
  }
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

import assert from "node:assert/strict";
import { test, after } from "node:test";

// AgentActivityPanel under jsdom + act. The blossom media boundary is
// stubbed (loader module-stub seam) so the portrait's signed fetch resolves
// deterministically; everything else is the real component tree.
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
  media: globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__,
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The auto-tail effect double-rAFs; queue and never flush — the scroll call
// it would make is irrelevant to these assertions.
const rafQueue = [];
globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
globalThis.cancelAnimationFrame = (id) => {
  rafQueue[id - 1] = null;
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/shared/api/blossom": `
    export async function fetchSignedMedia(url) {
      const handler = globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__;
      if (!handler) {
        throw new Error("test did not install a media handler");
      }
      return handler(url);
    }
  `,
};

const { AgentActivityPanel } = await import("./AgentActivityPanel.tsx");

const PUBKEY = "c".repeat(64);

function turnFrame() {
  return {
    id: "frame-1",
    createdAt: 1_700_000_000,
    seq: 1,
    timestamp: "2023-11-14T22:13:20Z",
    kind: "turn_started",
    agentIndex: null,
    channelId: null,
    sessionId: null,
    turnId: "t1",
    payload: null,
  };
}

async function mountPanel({ profile, frames = [turnFrame()] }) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(AgentActivityPanel, {
        agentPubkey: PUBKEY,
        agentName: "Richard",
        profile,
        frames,
        lockedCount: 0,
        connected: true,
        working: { working: false, startedAt: null },
        mobileOpen: false,
        onCloseMobile: () => {},
      }),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("the portrait block renders above the transcript; the header chip is unchanged", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => "blob:mock-panel";
  const { container, unmount } = await mountPanel({
    profile: {
      name: "Richard",
      displayName: "Richard",
      avatar: "https://media.test/pic",
    },
  });

  const portrait = container.querySelector('[data-testid="agent-portrait"]');
  assert.ok(portrait, "portrait block renders");
  const portraitImg = portrait.querySelector("img");
  assert.ok(portraitImg, "profile.avatar resolves to an img");
  assert.match(portraitImg.getAttribute("class") ?? "", /lg:aspect-\[3\/4\]/);
  assert.match(
    portraitImg.getAttribute("class") ?? "",
    /h-44/,
    "short banner crop below lg",
  );
  assert.ok(
    portrait.textContent?.includes("Richard"),
    "agent name shown under the frame",
  );
  assert.ok(
    portrait.textContent?.includes(
      "Who they want you to see — they can change it anytime.",
    ),
    "muted caption line present",
  );

  // Portrait sits ABOVE the transcript in document order.
  const transcript = container.querySelector("ol");
  assert.ok(transcript, "transcript list renders");
  assert.notEqual(
    portrait.compareDocumentPosition(transcript) &
      globalThis.window.Node.DOCUMENT_POSITION_FOLLOWING,
    0,
    "transcript follows the portrait block",
  );

  // Header chip: same picture, still the small circular size.
  const header = container.querySelector("header");
  assert.ok(header, "panel header renders");
  const chip = header?.querySelector("img");
  assert.ok(chip, "header chip renders the picture");
  const chipClass = chip?.getAttribute("class") ?? "";
  assert.match(chipClass, /rounded-full/);
  assert.match(chipClass, /h-5 w-5/, "chip stays size=sm");
  assert.doesNotMatch(chipClass, /lg:aspect-\[3\/4\]/);

  // The transcript still gets its rows (the turn divider from the frame).
  assert.ok(
    transcript?.textContent?.includes("Turn"),
    "transcript rows still render",
  );
  await unmount();
});

test("a profile without an avatar renders the initials frame, not a broken img", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => "blob:unused";
  const { container, unmount } = await mountPanel({
    profile: { name: "Richard", displayName: "Richard" },
  });

  const portrait = container.querySelector('[data-testid="agent-portrait"]');
  assert.ok(portrait, "portrait block still renders without an avatar");
  assert.equal(
    portrait.querySelector("img"),
    null,
    "no img element without a picture",
  );
  const frame = portrait.firstElementChild;
  assert.equal(frame?.tagName, "DIV");
  assert.equal(frame?.getAttribute("data-pubkey"), PUBKEY);
  assert.match(frame?.getAttribute("class") ?? "", /lg:aspect-\[3\/4\]/);
  assert.match(frame?.getAttribute("class") ?? "", /bg-/);
  assert.equal(frame?.textContent, "R");
  await unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    __BUZZ_TEST_FETCH_SIGNED_MEDIA__: originals.media,
    requestAnimationFrame: originals.raf,
    cancelAnimationFrame: originals.caf,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

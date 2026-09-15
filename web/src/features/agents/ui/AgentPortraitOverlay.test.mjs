import assert from "node:assert/strict";
import { test, after } from "node:test";

// AgentPortraitOverlay under jsdom + act — the same signed-media seam the
// AgentActivityPanel tests use, so the real AuthorAvatar resolves its fetch
// deterministically. Everything else is the real component tree.
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
};
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

const { AgentPortraitOverlay } = await import("./AgentPortraitOverlay.tsx");

const PUBKEY = "c".repeat(64);

async function mountOverlay({ picture }) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(AgentPortraitOverlay, {
        pubkey: PUBKEY,
        name: "Richard",
        picture,
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

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = originals.media;
});

test("renders only the frame — no name or caption under it (Sam, 2026-09-14)", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => "blob:mock-overlay";
  const { container, unmount } = await mountOverlay({
    picture: "https://media.test/pic",
  });

  const portrait = container.querySelector('[data-testid="agent-portrait"]');
  assert.ok(portrait, "overlay renders");
  const img = portrait.querySelector("img");
  assert.ok(img, "profile.avatar resolves to an img");
  assert.match(img.getAttribute("class") ?? "", /lg:aspect-\[3\/4\]/);
  assert.equal(
    portrait.textContent?.trim(),
    "",
    "the overlay is the bare picture — name and caption removed by request",
  );
  await unmount();
});

test("a profile without an avatar renders the initials frame, not a broken img", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => "blob:unused";
  const { container, unmount } = await mountOverlay({ picture: undefined });

  const portrait = container.querySelector('[data-testid="agent-portrait"]');
  assert.ok(portrait, "overlay still renders without an avatar");
  assert.equal(portrait.querySelector("img"), null, "no img without a picture");
  const frame = portrait.firstElementChild;
  assert.equal(frame?.tagName, "DIV");
  assert.equal(frame?.getAttribute("data-pubkey"), PUBKEY);
  await unmount();
});

test("placement pins: stationary in the chat column and fluid with the pane width", async () => {
  // Sam's placement verdict (2026-09-14): the portrait must live over the
  // chat area — not inside the thinking pane, where it scrolled away — and
  // must reflow when the thinking/thread pane is dragged. The mechanism is
  // the wrapper's fluid width (a percentage of the chat column, capped) plus
  // absolute anchoring; a fixed pixel box here would be the regression.
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => "blob:unused";
  const { container, unmount } = await mountOverlay({ picture: undefined });

  const portrait = container.querySelector('[data-testid="agent-portrait"]');
  const cls = portrait?.getAttribute("class") ?? "";
  assert.match(cls, /\babsolute\b/, "anchored inside the chat section");
  assert.match(cls, /\bright-3\b/, "pinned to the chat/divider gutter");
  assert.match(cls, /\bw-\[min\(12rem,24%\)\]/, "width is fluid, not fixed");
  assert.match(cls, /\bpointer-events-none\b/, "never blocks the chat");
  assert.match(cls, /\bhidden\b/, "not rendered on phones");
  assert.match(cls, /\blg:block\b/, "desktop overlay, not a mobile cover");
  await unmount();
});

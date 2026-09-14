import assert from "node:assert/strict";
import { test, after } from "node:test";

// AuthorAvatar renders under jsdom + act (web has no browser test runner of
// its own; this mirrors desktop's hook/component harness). The blossom media
// module is stubbed (loader module-stub seam) so the signed-fetch boundary is
// scriptable per test: resolve to an object URL, or reject to exercise the
// initials fallback.
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

const { AuthorAvatar } = await import("./AuthorAvatar.tsx");

const PUBKEY = "b".repeat(64);

async function mountAvatar(props) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AuthorAvatar, props));
  });
  return {
    html: () => container.innerHTML,
    first: () => container.firstElementChild,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const resolveTo = (url) => async () => url;

test("default (no shape) keeps the circular picture once it resolves", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = resolveTo("blob:mock-circle");
  const avatar = await mountAvatar({
    pubkey: PUBKEY,
    label: "Richard",
    picture: "https://media.test/pic",
  });
  const el = avatar.first();
  assert.equal(el?.tagName, "IMG");
  assert.match(el.getAttribute("class") ?? "", /rounded-full/);
  assert.doesNotMatch(el.getAttribute("class") ?? "", /aspect-\[3\/4\]/);
  await avatar.unmount();
});

test("shape=portrait renders the 3:4 frame classes, not a circle", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = resolveTo("blob:mock-frame");
  const avatar = await mountAvatar({
    pubkey: PUBKEY,
    label: "Richard",
    picture: "https://media.test/pic",
    shape: "portrait",
  });
  const el = avatar.first();
  assert.equal(el?.tagName, "IMG");
  const cls = el.getAttribute("class") ?? "";
  // Box per the brief: short banner below lg, true 3:4 frame at lg.
  assert.match(cls, /h-44/);
  assert.match(cls, /w-full/);
  assert.match(cls, /rounded-xl/);
  assert.match(cls, /border-border/);
  assert.match(cls, /object-cover/);
  assert.match(cls, /lg:aspect-\[3\/4\]/);
  assert.match(cls, /lg:h-auto/);
  assert.doesNotMatch(cls, /rounded-full/);
  await avatar.unmount();
});

test("shape=portrait falls back to the initials frame when the fetch fails", async () => {
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => {
    throw new Error("media unavailable");
  };
  const avatar = await mountAvatar({
    pubkey: PUBKEY,
    label: "Richard Hendricks",
    picture: "https://media.test/pic",
    shape: "portrait",
  });
  const el = avatar.first();
  assert.equal(el?.tagName, "DIV");
  const cls = el.getAttribute("class") ?? "";
  assert.match(cls, /h-44/);
  assert.match(cls, /lg:aspect-\[3\/4\]/);
  assert.match(cls, /bg-/); // palette entry
  assert.equal(el.getAttribute("data-pubkey"), PUBKEY);
  assert.equal(el.textContent, "RH");
  await avatar.unmount();
});

test("no picture renders the initials frame without any media fetch", async () => {
  let called = false;
  globalThis.__BUZZ_TEST_FETCH_SIGNED_MEDIA__ = async () => {
    called = true;
    return "blob:unused";
  };
  const avatar = await mountAvatar({
    pubkey: PUBKEY,
    label: "Grumpy",
    shape: "portrait",
  });
  const el = avatar.first();
  assert.equal(el?.tagName, "DIV");
  assert.match(el.getAttribute("class") ?? "", /lg:aspect-\[3\/4\]/);
  assert.equal(el.textContent, "G");
  assert.equal(called, false);
  await avatar.unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    __BUZZ_TEST_MODULE_STUBS__: originals.stubs,
    __BUZZ_TEST_FETCH_SIGNED_MEDIA__: originals.media,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

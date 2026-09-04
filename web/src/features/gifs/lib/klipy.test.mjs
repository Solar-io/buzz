import assert from "node:assert/strict";
import test from "node:test";

import {
  gifMarkdown,
  gifsFromSearchResponse,
  klipyGifFilename,
  normalizeKlipyGifs,
  relayGifCapability,
} from "./klipy.ts";

const asset = (url, width = 200, height = 100, size = 1234) => ({
  url,
  width,
  height,
  size,
});

const rawGif = (overrides = {}) => ({
  id: 7,
  slug: "ship-it",
  title: "  Ship It  ",
  type: "gif",
  file: {
    md: { gif: asset("https://cdn.example/md.gif", 400, 200, 90_000) },
    sm: {
      gif: asset("https://cdn.example/sm.gif"),
      webp: asset("https://cdn.example/sm.webp"),
      jpg: asset("https://cdn.example/sm.jpg"),
    },
  },
  ...overrides,
});

// The NIP-11 shape a GIF-configured relay publishes
// (crates/buzz-relay/src/nip11.rs:181).
const INFO = {
  supported_extensions: ["nip-er", "buzz-gif"],
  gif: { provider: "klipy", search: "/gifs/search", share: "/gifs/share" },
};

test("a relay advertising buzz-gif yields its endpoints", () => {
  assert.deepEqual(relayGifCapability(INFO), {
    provider: "klipy",
    searchPath: "/gifs/search",
    sharePath: "/gifs/share",
  });
});

test("a relay with no GIF provider yields no capability", () => {
  assert.equal(relayGifCapability({ supported_extensions: ["nip-er"] }), null);
  assert.equal(relayGifCapability({}), null);
  assert.equal(
    relayGifCapability({ ...INFO, supported_extensions: ["nip-er"] }),
    null,
    "the extension must be advertised, not just the descriptor",
  );
  assert.equal(
    relayGifCapability({ ...INFO, gif: { ...INFO.gif, provider: "" } }),
    null,
  );
});

test("an unsafe advertised path is refused", () => {
  const unsafe = [
    "//evil.example/gifs",
    "https://evil.example/gifs",
    "gifs/search",
    "/gifs/../../admin",
    "/gifs/search?x=1",
    "/gifs/search#frag",
    "/gifs/%2e%2e/admin",
    "/gifs\\search",
  ];
  for (const search of unsafe) {
    assert.equal(
      relayGifCapability({ ...INFO, gif: { ...INFO.gif, search } }),
      null,
      `must refuse ${search}`,
    );
  }
});

test("a GIF is normalized to original, preview and poster", () => {
  const [gif, ...rest] = normalizeKlipyGifs([rawGif()]);
  assert.equal(rest.length, 0);
  assert.equal(gif.id, 7);
  assert.equal(gif.slug, "ship-it");
  assert.equal(gif.title, "Ship It", "the title is trimmed");
  assert.equal(gif.original.url, "https://cdn.example/md.gif");
  assert.equal(gif.preview.url, "https://cdn.example/sm.webp");
  assert.equal(gif.poster.url, "https://cdn.example/sm.jpg");
});

test("records that are not usable GIFs are dropped", () => {
  const dropped = normalizeKlipyGifs([
    rawGif({ type: "ad" }),
    rawGif({ file: undefined }),
    rawGif({ slug: undefined }),
    // A file set with no complete asset: url present, dimensions missing.
    rawGif({ file: { md: { gif: { url: "https://cdn.example/x.gif" } } } }),
  ]);
  assert.deepEqual(dropped, []);
});

test("an untitled GIF still gets a label", () => {
  const [gif] = normalizeKlipyGifs([rawGif({ title: "   " })]);
  assert.equal(gif.title, "GIF");
});

test("a GIF with no static asset has a null poster rather than a bad one", () => {
  const [gif] = normalizeKlipyGifs([
    rawGif({
      file: { md: { gif: asset("https://cdn.example/md.gif") } },
    }),
  ]);
  assert.equal(gif.poster, null);
  assert.equal(gif.preview.url, "https://cdn.example/md.gif", "falls back");
});

test("the relay's success envelope is unwrapped", () => {
  assert.equal(
    gifsFromSearchResponse({ result: true, data: { data: [rawGif()] } }).length,
    1,
  );
  assert.deepEqual(gifsFromSearchResponse({ result: true }), []);
  assert.deepEqual(gifsFromSearchResponse({}), []);
  assert.deepEqual(
    gifsFromSearchResponse({ result: false, data: { data: [rawGif()] } }),
    [],
  );
});

test("a chosen GIF becomes an image link and nothing else", () => {
  const [gif] = normalizeKlipyGifs([rawGif()]);
  const markdown = gifMarkdown(gif);
  assert.equal(markdown, "![Ship It](https://cdn.example/md.gif)");
  assert.ok(
    !markdown.includes("imeta"),
    "an externally hosted GIF must not claim an imeta entry",
  );
});

test("the filename is slugified and bounded", () => {
  const [gif] = normalizeKlipyGifs([rawGif({ slug: "Ship It!! 2024" })]);
  assert.equal(klipyGifFilename(gif), "ship-it-2024.gif");
  const [odd] = normalizeKlipyGifs([rawGif({ slug: "!!!" })]);
  assert.equal(klipyGifFilename(odd), "klipy-gif.gif");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MEDIA_RESERVE,
  dimensionsFromDim,
  formatFileSize,
  galleryFromTriggers,
  isNonMediaAttachment,
  mediaFrame,
  mosaicLayout,
  resolveFileCard,
} from "./messageMedia.ts";

// --- dimensionsFromDim -----------------------------------------------------

test("dimensionsFromDim reads a NIP-92 dim field", () => {
  assert.deepEqual(dimensionsFromDim("1200x800"), {
    width: 1200,
    height: 800,
  });
});

test("dimensionsFromDim rejects malformed dims rather than coercing them", () => {
  for (const bad of [
    undefined,
    "",
    "1200",
    "1200x",
    "x800",
    "1200*800",
    "1200x800x2",
    "-1200x800",
    "12.5x800",
    "0x800",
    "1200x0",
    "widthxheight",
  ]) {
    assert.equal(dimensionsFromDim(bad), undefined, `expected reject: ${bad}`);
  }
});

// --- mediaFrame ------------------------------------------------------------

test("mediaFrame keeps the source aspect ratio so the row cannot reflow", () => {
  const frame = mediaFrame("1200x800");
  assert.equal(frame.aspectRatio, "1200 / 800");
  assert.equal(frame.reserved, false);
});

test("mediaFrame caps a wide image at the 384px inline width", () => {
  // 1200x800 scaled by min(1, 384/1200, 256/800) = 0.32 -> 384 wide.
  assert.equal(mediaFrame("1200x800").width, 384);
});

test("mediaFrame caps a tall image by HEIGHT, not width", () => {
  // 800x1600 scaled by min(1, 384/800, 256/1600) = 0.16 -> 128 wide.
  // A width-only cap would give 384 here, and a 768px-tall row.
  assert.equal(mediaFrame("800x1600").width, 128);
});

test("mediaFrame never upscales a small image", () => {
  const frame = mediaFrame("64x48");
  assert.equal(frame.width, 64);
  assert.equal(frame.aspectRatio, "64 / 48");
});

test("mediaFrame falls back to the fixed reserve box when dim is absent", () => {
  const frame = mediaFrame(undefined);
  assert.equal(frame.reserved, true);
  assert.equal(frame.width, DEFAULT_MEDIA_RESERVE.width);
  assert.equal(
    frame.aspectRatio,
    `${DEFAULT_MEDIA_RESERVE.width} / ${DEFAULT_MEDIA_RESERVE.height}`,
  );
});

// --- mosaicLayout ----------------------------------------------------------

test("mosaicLayout: fewer than two images is not a mosaic", () => {
  assert.equal(mosaicLayout(0), null);
  assert.equal(mosaicLayout(1), null);
  assert.equal(mosaicLayout(-3), null);
  assert.equal(mosaicLayout(2.5), null);
});

test("mosaicLayout: two images split one row", () => {
  assert.deepEqual(mosaicLayout(2), {
    shape: "pair",
    rowSpanIndex: null,
    colSpanIndex: null,
    fixedHeight: false,
  });
});

test("mosaicLayout: three images form a hero-and-stack triptych", () => {
  assert.deepEqual(mosaicLayout(3), {
    shape: "triptych",
    rowSpanIndex: 0,
    colSpanIndex: null,
    fixedHeight: true,
  });
});

test("mosaicLayout: four images tile evenly with no spanning tile", () => {
  assert.deepEqual(mosaicLayout(4), {
    shape: "grid",
    rowSpanIndex: null,
    colSpanIndex: null,
    fixedHeight: false,
  });
});

test("mosaicLayout: an odd tail above three spans both columns", () => {
  assert.equal(mosaicLayout(5).colSpanIndex, 4);
  assert.equal(mosaicLayout(7).colSpanIndex, 6);
  assert.equal(mosaicLayout(6).colSpanIndex, null);
  assert.equal(mosaicLayout(8).colSpanIndex, null);
});

test("mosaicLayout: only the triptych sets a fixed container height", () => {
  assert.equal(mosaicLayout(2).fixedHeight, false);
  assert.equal(mosaicLayout(3).fixedHeight, true);
  assert.equal(mosaicLayout(4).fixedHeight, false);
  assert.equal(mosaicLayout(5).fixedHeight, false);
});

// --- formatFileSize --------------------------------------------------------

test("formatFileSize renders bytes, KB, MB and GB", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(820), "820 B");
  assert.equal(formatFileSize(1024), "1.0 KB");
  assert.equal(formatFileSize(9216), "9.0 KB");
  // At and above 10 the decimal is dropped — desktop parity.
  assert.equal(formatFileSize(12_698), "12 KB");
  assert.equal(formatFileSize(1024 * 1024 * 3.1), "3.1 MB");
  assert.equal(formatFileSize(1024 * 1024 * 40), "40 MB");
  assert.equal(formatFileSize(1024 ** 3 * 2), "2.0 GB");
});

test("formatFileSize returns an empty label for nonsense sizes", () => {
  assert.equal(formatFileSize(-1), "");
  assert.equal(formatFileSize(Number.NaN), "");
  assert.equal(formatFileSize(Number.POSITIVE_INFINITY), "");
});

// --- file cards ------------------------------------------------------------

const PDF = {
  url: "u",
  m: "application/pdf",
  size: 2048,
  filename: "spec.pdf",
};

test("isNonMediaAttachment is true only for a known non-media MIME", () => {
  assert.equal(isNonMediaAttachment(PDF), true);
  assert.equal(isNonMediaAttachment({ url: "u", m: "image/png" }), false);
  assert.equal(isNonMediaAttachment({ url: "u", m: "video/mp4" }), false);
  // No MIME: legacy events omit `m` and are overwhelmingly images. Guessing
  // "file" here would replace working images with download cards.
  assert.equal(isNonMediaAttachment({ url: "u" }), false);
  assert.equal(isNonMediaAttachment(undefined), false);
});

test("resolveFileCard prefers the imeta filename", () => {
  assert.deepEqual(resolveFileCard(PDF, "https://r/media/abc", "click me"), {
    href: "https://r/media/abc",
    filename: "spec.pdf",
    size: 2048,
  });
});

test("resolveFileCard falls back to link text, then the URL tail", () => {
  assert.equal(
    resolveFileCard(
      { url: "u", m: "application/zip" },
      "https://r/media/abc",
      "  bundle.zip  ",
    ).filename,
    "bundle.zip",
  );
  assert.equal(
    resolveFileCard(
      { url: "u", m: "application/zip" },
      "https://r/media/abc",
      "",
    ).filename,
    "abc",
  );
});

test("resolveFileCard omits size when imeta carries none", () => {
  const card = resolveFileCard(
    { url: "u", m: "application/zip" },
    "https://r/media/abc",
    "b.zip",
  );
  assert.equal("size" in card, false);
});

test("resolveFileCard declines images, videos and missing hrefs", () => {
  assert.equal(resolveFileCard(PDF, undefined, "x"), null);
  assert.equal(
    resolveFileCard({ url: "u", m: "image/png" }, "https://r/a.png", "x"),
    null,
  );
  assert.equal(
    resolveFileCard({ url: "u", m: "video/mp4" }, "https://r/a.mp4", "x"),
    null,
  );
  assert.equal(resolveFileCard(undefined, "https://r/a", "x"), null);
});

// --- gallery ---------------------------------------------------------------

function trigger(src, alt) {
  return { dataset: { lightboxSrc: src, lightboxAlt: alt } };
}

test("galleryFromTriggers keeps DOM order and finds the clicked item", () => {
  const a = trigger("blob:a", "one");
  const b = trigger("blob:b", "two");
  const c = trigger("blob:c", "three");
  const gallery = galleryFromTriggers([a, b, c], b);
  assert.equal(gallery.items.length, 3);
  assert.deepEqual(
    gallery.items.map((item) => item.src),
    ["blob:a", "blob:b", "blob:c"],
  );
  assert.equal(gallery.index, 1);
  assert.equal(gallery.items[1].alt, "two");
});

test("galleryFromTriggers skips unresolved images and re-bases the index", () => {
  const pending = { dataset: {} };
  const a = trigger("blob:a", "one");
  const b = trigger("blob:b", "two");
  // Two pending images ahead of `b`: a DOM-position index would say 3.
  const gallery = galleryFromTriggers([pending, a, pending, b], b);
  assert.equal(gallery.items.length, 2);
  assert.equal(gallery.index, 1);
});

test("galleryFromTriggers degrades to a one-item gallery off-scope", () => {
  const loose = trigger("blob:z", "z");
  const gallery = galleryFromTriggers([trigger("blob:a", "a")], loose);
  assert.deepEqual(gallery.items, [{ src: "blob:z", alt: "z" }]);
  assert.equal(gallery.index, 0);
});

test("galleryFromTriggers defaults a missing alt to an empty string", () => {
  const bare = { dataset: { lightboxSrc: "blob:a" } };
  assert.equal(galleryFromTriggers([bare], bare).items[0].alt, "");
});

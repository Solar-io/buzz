import assert from "node:assert/strict";
import { test } from "node:test";
import { linkPreviewsFromTags } from "./linkPreview.ts";

/**
 * These tags arrive already validated by the relay, so the vectors here are
 * about what happens when that guarantee does NOT hold — an older relay, or a
 * fork without the check. A malformed tag must drop its preview, never throw
 * inside a render and never smuggle a non-https URL onto the page.
 */

const IMG = "https://relay.example/blob/aaa.png";
const ICON = "https://relay.example/blob/bbb.png";

function snapshot(url, over = {}) {
  return [
    "link-preview",
    "snapshot",
    "1",
    url,
    over.title ?? "A title",
    over.site ?? "example.com",
    over.description ?? "A description",
    over.imageUrl ?? IMG,
    "sha-image",
    over.faviconUrl ?? ICON,
    "sha-icon",
  ];
}

test("a well-formed snapshot becomes a preview", () => {
  const { previews, suppressed } = linkPreviewsFromTags([
    snapshot("https://example.com/post"),
  ]);
  assert.equal(suppressed, false);
  assert.deepEqual(previews, [
    {
      url: "https://example.com/post",
      title: "A title",
      site: "example.com",
      description: "A description",
      imageUrl: IMG,
      faviconUrl: ICON,
    },
  ]);
});

test("the suppression marker yields no previews", () => {
  const result = linkPreviewsFromTags([["link-preview", "none"]]);
  assert.equal(result.suppressed, true);
  assert.deepEqual(result.previews, []);
});

test("suppression wins even when a snapshot is also present", () => {
  // The relay rejects this combination; a fork might not. "The sender said no
  // previews" is the safer reading, and this pins that choice.
  const result = linkPreviewsFromTags([
    snapshot("https://example.com/post"),
    ["link-preview", "none"],
  ]);
  assert.equal(result.suppressed, true);
  assert.deepEqual(result.previews, []);
});

test("a non-https canonical URL is dropped", () => {
  // The relay enforces https. If it ever did not, rendering an http card
  // would be a mixed-content and phishing surface.
  assert.deepEqual(
    linkPreviewsFromTags([snapshot("http://example.com/post")]).previews,
    [],
  );
  assert.deepEqual(
    linkPreviewsFromTags([snapshot("javascript:alert(1)")]).previews,
    [],
  );
});

test("a tag with the wrong part count is dropped, not partially read", () => {
  const short = ["link-preview", "snapshot", "1", "https://example.com/post"];
  assert.deepEqual(linkPreviewsFromTags([short]).previews, []);
  const long = [...snapshot("https://example.com/post"), "extra"];
  assert.deepEqual(linkPreviewsFromTags([long]).previews, []);
});

test("an unknown snapshot version is dropped", () => {
  const tag = snapshot("https://example.com/post");
  tag[2] = "2";
  assert.deepEqual(linkPreviewsFromTags([tag]).previews, []);
});

test("duplicate URLs collapse to one card", () => {
  const { previews } = linkPreviewsFromTags([
    snapshot("https://example.com/post"),
    snapshot("https://example.com/post", { title: "Second" }),
  ]);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].title, "A title", "the first tag wins");
});

test("multiple distinct URLs each get a card, in tag order", () => {
  const { previews } = linkPreviewsFromTags([
    snapshot("https://a.example/1"),
    snapshot("https://b.example/2"),
  ]);
  assert.deepEqual(
    previews.map((p) => p.url),
    ["https://a.example/1", "https://b.example/2"],
  );
});

test("unrelated tags are ignored", () => {
  const result = linkPreviewsFromTags([
    ["e", "abc", "", "reply"],
    ["p", "def"],
    ["imeta", "url https://example.com/x.png"],
  ]);
  assert.deepEqual(result.previews, []);
  assert.equal(result.suppressed, false);
});

test("empty optional text fields are preserved as empty strings", () => {
  // A page with no og:description is normal; the renderer decides what to do
  // about it, and must not receive undefined.
  const { previews } = linkPreviewsFromTags([
    snapshot("https://example.com/post", {
      description: "",
      site: "",
      imageUrl: "",
      faviconUrl: "",
    }),
  ]);
  assert.equal(previews[0].description, "");
  assert.equal(previews[0].site, "");
  assert.equal(previews[0].imageUrl, "");
});

test("no tags at all is not an error", () => {
  const result = linkPreviewsFromTags([]);
  assert.deepEqual(result.previews, []);
  assert.equal(result.suppressed, false);
});

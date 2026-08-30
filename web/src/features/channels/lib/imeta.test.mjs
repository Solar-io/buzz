import assert from "node:assert/strict";
import { test } from "node:test";
import { buildImetaTag, imetaUrls, mediaMarkdown } from "./imeta.ts";

const descriptor = {
  url: "https://relay.example/media/abc.png",
  sha256: "a".repeat(64),
  mime_type: "image/png",
  size: 12345,
  dim: "640x480",
};

test("imeta tag carries the five required fields in CLI order", () => {
  assert.deepEqual(buildImetaTag(descriptor), [
    "imeta",
    "url https://relay.example/media/abc.png",
    "m image/png",
    `x ${"a".repeat(64)}`,
    "size 12345",
    "dim 640x480",
  ]);
});

test("optional descriptor fields are omitted, not blank", () => {
  const tag = buildImetaTag({
    url: "u",
    sha256: "s",
    mime_type: "video/mp4",
    size: 5,
    duration: 12,
  });
  assert.ok(!tag.some((f) => f.startsWith("dim ")));
  assert.ok(!tag.some((f) => f.startsWith("blurhash ")));
  assert.ok(!tag.some((f) => f.startsWith("thumb ")));
  assert.deepEqual(tag.at(-1), "duration 12");
});

test("media markdown uses video kind for videos, image otherwise", () => {
  assert.equal(
    mediaMarkdown(descriptor),
    "\n![image](https://relay.example/media/abc.png)",
  );
  assert.equal(
    mediaMarkdown({ ...descriptor, mime_type: "video/mp4" }),
    "\n![video](https://relay.example/media/abc.png)",
  );
});

test("imetaUrls pulls url fields from a tag list", () => {
  const tags = [
    ["h", "chan"],
    ["imeta", "url https://a/1.png", "m image/png"],
    ["p", "b".repeat(64)],
    ["imeta", "m video/mp4", "url https://a/2.mp4"],
  ];
  assert.deepEqual(imetaUrls(tags), ["https://a/1.png", "https://a/2.mp4"]);
  assert.deepEqual(imetaUrls([["h", "chan"]]), []);
});

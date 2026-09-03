import assert from "node:assert/strict";
import { test } from "node:test";
import { imetaByUrl, parseImetaEntry } from "./imetaEntries.ts";

const SHA = "a".repeat(64);
const URL = "https://relay.example/media/abc123";

function snapshotTag(overrides = {}) {
  return [
    "imeta",
    `url ${URL}`,
    "m image/png",
    `x ${SHA}`,
    "size 2048",
    "filename night-shift.agent.png",
    ...(overrides.extra ?? []),
  ];
}

test("parses the snapshot share shape: url/m/x/size/filename", () => {
  assert.deepEqual(parseImetaEntry(snapshotTag()), {
    url: URL,
    m: "image/png",
    x: SHA,
    size: 2048,
    filename: "night-shift.agent.png",
  });
});

test("field order is irrelevant; unknown fields are ignored", () => {
  const entry = parseImetaEntry([
    "imeta",
    "fallback https://other.example/x",
    "alt a picture",
    `x ${SHA}`,
    "url https://relay.example/media/z",
    "dim 640x480",
  ]);
  assert.deepEqual(entry, {
    url: "https://relay.example/media/z",
    x: SHA,
    dim: "640x480",
  });
});

test("first url in a tag wins; later url fields cannot redirect it", () => {
  const entry = parseImetaEntry([
    "imeta",
    "url https://relay.example/media/first",
    "m application/json",
    "url https://evil.example/media/second",
  ]);
  assert.equal(entry.url, "https://relay.example/media/first");
  // The trailing m still binds to the tag's one true url.
  assert.equal(entry.m, "application/json");
});

test("malformed numeric fields are skipped, not coerced", () => {
  const entry = parseImetaEntry([
    "imeta",
    `url ${URL}`,
    "size not-a-number",
    "duration NaN",
  ]);
  assert.deepEqual(entry, { url: URL });
});

test("fields without a space, non-imeta tags, and url-less tags yield null", () => {
  assert.equal(parseImetaEntry(["imeta", "nofields"]), null);
  assert.equal(parseImetaEntry(["h", "chan-1"]), null);
  assert.equal(parseImetaEntry(["imeta", "m image/png", `x ${SHA}`]), null);
  assert.equal(parseImetaEntry([]), null);
});

test("imetaByUrl maps url to entry and ignores non-imeta tags", () => {
  const map = imetaByUrl([
    ["h", "chan-1"],
    snapshotTag(),
    ["p", "b".repeat(64)],
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(URL).filename, "night-shift.agent.png");
});

test("duplicate urls across tags: last tag wins (desktop map.set parity)", () => {
  const map = imetaByUrl([
    ["imeta", `url ${URL}`, "m application/octet-stream"],
    ["imeta", `url ${URL}`, "m image/png", `x ${SHA}`],
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(URL).m, "image/png");
  assert.equal(map.get(URL).x, SHA);
});

test("duration and blurhash parse as numbers/strings respectively", () => {
  const entry = parseImetaEntry([
    "imeta",
    "url https://relay.example/media/v",
    "duration 12.5",
    "blurhash UFBjY0Zt",
  ]);
  assert.equal(entry.duration, 12.5);
  assert.equal(entry.blurhash, "UFBjY0Zt");
});

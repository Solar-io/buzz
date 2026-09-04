import assert from "node:assert/strict";
import { test } from "node:test";
import { isRelayMediaHref, linkDisposition } from "./linkOpen.ts";

const RELAY = "https://crichton.tailb3d4b8.ts.net:6351";

test("linkDisposition: file-typical URLs are popup", () => {
  assert.equal(linkDisposition("https://example.com/a.png"), "popup");
  assert.equal(
    linkDisposition(`${RELAY}/media/0c67${"a".repeat(56)}.png`),
    "popup",
  );
  assert.equal(linkDisposition("https://host/edition/latest.md"), "popup");
  assert.equal(linkDisposition("https://host/report.pdf?download=1"), "popup");
  assert.equal(linkDisposition("https://host/clip.MOV"), "popup");
  assert.equal(linkDisposition("https://host/archive.tar.gz"), "popup");
  assert.equal(linkDisposition("/relative/notes.txt"), "popup");
});

test("linkDisposition: non-file URLs are tab", () => {
  assert.equal(linkDisposition("https://iana.org"), "tab");
  assert.equal(
    linkDisposition("https://openclaw.ai/blog/openclaw-2-accidentally"),
    "tab",
  );
  assert.equal(linkDisposition(`${RELAY}/repos?c=abc`), "tab");
  assert.equal(linkDisposition("/repos"), "tab");
});

test("linkDisposition: non-http schemes and garbage use browser default", () => {
  assert.equal(linkDisposition("mailto:sam@example.com"), "default");
  assert.equal(linkDisposition("javascript:alert(1)"), "default");
  assert.equal(linkDisposition(""), "default");
});

test("linkDisposition: extension-looking hosts and no-extension files don't misfire", () => {
  // host TLD is not a file extension
  assert.equal(linkDisposition("https://example.sh"), "tab");
  // trailing slash = directory
  assert.equal(linkDisposition("https://example.com/files/"), "tab");
});

test("isRelayMediaHref: only same-host /media/ paths", () => {
  assert.equal(
    isRelayMediaHref(`${RELAY}/media/${"a".repeat(64)}.png`, RELAY),
    true,
  );
  assert.equal(
    isRelayMediaHref(`${RELAY}/media/${"a".repeat(64)}.thumb.jpg`, RELAY),
    true,
  );
  assert.equal(isRelayMediaHref(`${RELAY}/repos`, RELAY), false);
  assert.equal(
    isRelayMediaHref(`https://evil.example/media/${"a".repeat(64)}.png`, RELAY),
    false,
  );
  assert.equal(isRelayMediaHref("not a url", RELAY), false);
});

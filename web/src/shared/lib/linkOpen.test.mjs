import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileViewerKind,
  isRelayEditionHref,
  isRelayMediaHref,
  linkDisposition,
  openLink,
} from "./linkOpen.ts";

const RELAY = "https://crichton.tailb3d4b8.ts.net:6351";

test("linkDisposition: file-typical URLs are overlay", () => {
  assert.equal(linkDisposition("https://example.com/a.png"), "overlay");
  assert.equal(
    linkDisposition(`${RELAY}/media/0c67${"a".repeat(56)}.png`),
    "overlay",
  );
  assert.equal(linkDisposition("https://host/edition/latest.md"), "overlay");
  assert.equal(
    linkDisposition("https://host/report.pdf?download=1"),
    "overlay",
  );
  assert.equal(linkDisposition("https://host/clip.MOV"), "overlay");
  assert.equal(linkDisposition("https://host/archive.tar.gz"), "overlay");
  assert.equal(linkDisposition("/relative/notes.txt"), "overlay");
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

test("fileViewerKind: dispatches the viewer renderer by extension", () => {
  assert.equal(fileViewerKind("https://x.test/pic.PNG"), "image");
  assert.equal(fileViewerKind("https://x.test/clip.mov"), "video");
  assert.equal(fileViewerKind("https://x.test/voice note.M4A"), "audio");
  assert.equal(fileViewerKind("https://x.test/report.pdf"), "pdf");
  assert.equal(fileViewerKind("https://x.test/notes.md"), "markdown");
  assert.equal(fileViewerKind("https://x.test/data.csv"), "text");
  assert.equal(fileViewerKind("https://x.test/main.rs"), "text");
  assert.equal(fileViewerKind("https://x.test/page.html"), "html");
  // Office documents, archives, and unknown extensions have no in-app
  // preview — they render the fallback (icon + download).
  assert.equal(fileViewerKind("https://x.test/deck.pptx"), "fallback");
  assert.equal(fileViewerKind("https://x.test/backup.zip"), "fallback");
  assert.equal(fileViewerKind("https://x.test/no-extension"), "fallback");
});

test("openLink: opens a _blank tab for tab links and never opens a window for overlay links", () => {
  // Minimal window stub — openLink reads location.origin and calls open.
  const opened = [];
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: { origin: "https://web.test" },
    open: (url, target, features) => {
      opened.push({ url, target, features });
      return null;
    },
  };

  try {
    // A tab link: one deliberate _blank window with noopener.
    assert.equal(openLink("https://iana.org"), "tab");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, "https://iana.org/");
    assert.equal(opened[0].target, "_blank");
    assert.match(opened[0].features, /noopener/);

    // An overlay link must NOT create any window — it belongs to the viewer.
    opened.length = 0;
    assert.equal(openLink("https://example.com/a.png"), "overlay");
    assert.equal(opened.length, 0, "overlay links never create a window");

    // A default link creates nothing.
    assert.equal(openLink("mailto:sam@example.com"), "default");
    assert.equal(opened.length, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("isRelayEditionHref matches only relay-origin /edition/ pages", () => {
  const RELAY = "https://crichton.tailb3d4b8.ts.net:6351";
  assert.equal(
    isRelayEditionHref(`${RELAY}/edition/latest.html`, RELAY),
    true,
  );
  // Same host, wrong port (the upstream :6450) is NOT the relay docs proxy.
  assert.equal(
    isRelayEditionHref("https://crichton.tailb3d4b8.ts.net:6450/edition/latest.html", RELAY),
    false,
  );
  // Relay origin but not an edition path — strangers stay scriptless.
  assert.equal(isRelayEditionHref(`${RELAY}/media/x.html`, RELAY), false);
  assert.equal(isRelayEditionHref(`${RELAY}/changelog.md`, RELAY), false);
  assert.equal(isRelayEditionHref("https://other.host/edition/x.html", RELAY), false);
  assert.equal(isRelayEditionHref("not a url", RELAY), false);
});

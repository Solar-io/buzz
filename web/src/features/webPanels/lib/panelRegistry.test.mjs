import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CUSTOM_PANELS_STORAGE_KEY,
  MAX_CUSTOM_PANELS,
  addCustomPanel,
  allPanels,
  defaultPanelLabel,
  findPanel,
  nextCustomPanelId,
  normalizePanelUrl,
  readCustomPanels,
  removeCustomPanel,
  withThemeParam,
  writeCustomPanels,
} from "./panelRegistry.ts";

function memoryStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    raw: store,
  };
}

test("http and https survive normalization", () => {
  assert.equal(
    normalizePanelUrl("https://files.example/x"),
    "https://files.example/x",
  );
  assert.equal(
    normalizePanelUrl(" http://box.lan:8080 "),
    "http://box.lan:8080/",
  );
});

test("a bare host is assumed https", () => {
  assert.equal(normalizePanelUrl("files.example"), "https://files.example/");
});

test("every scheme that can execute in this origin is REFUSED", () => {
  // An iframe src of javascript:/data:/blob: runs in this document's origin,
  // and this origin holds the user's Nostr key. Rejected, never coerced.
  for (const hostile of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://evil.example/abc",
    "file:///etc/passwd",
    "about:blank",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(
      normalizePanelUrl(hostile),
      null,
      `${hostile} must not be accepted`,
    );
  }
});

test("a hostile scheme that DOES carry a host is refused by the allowlist", () => {
  // The hostname check alone does not cover these: `javascript://evil.example/
  // %0aalert(1)` parses with hostname "evil.example", and a chrome-extension
  // or ftp URL has a real host too. Only the protocol allowlist stops them,
  // so these are the cases that actually pin it.
  for (const hostile of [
    "javascript://evil.example/%0aalert(1)",
    "ftp://files.example/pub",
    "ws://relay.example/socket",
    "chrome-extension://abcdefghijklmnop/page.html",
  ]) {
    assert.equal(
      normalizePanelUrl(hostile),
      null,
      `${hostile} must not be accepted`,
    );
  }
});

test("empty and unparseable input is refused", () => {
  assert.equal(normalizePanelUrl(""), null);
  assert.equal(normalizePanelUrl("   "), null);
  assert.equal(normalizePanelUrl("https://"), null);
});

test("the default label is the host", () => {
  assert.equal(
    defaultPanelLabel("https://files.example/x?y=1"),
    "files.example",
  );
});

test("withThemeParam adds a theme and never overwrites one", () => {
  assert.equal(
    withThemeParam("https://x.example/", true),
    "https://x.example/?theme=dark",
  );
  assert.equal(
    withThemeParam("https://x.example/?theme=dark", false),
    "https://x.example/?theme=dark",
  );
});

test("adding a site normalizes, labels, and allocates an id", () => {
  const result = addCustomPanel([], { url: "files.example" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, {
    id: "custom:1",
    label: "files.example",
    url: "https://files.example/",
    custom: true,
  });
});

test("de-duplication is on the normalized URL, not the typed text", () => {
  const first = addCustomPanel([], { url: "https://files.example/" });
  const second = addCustomPanel(first.panels, { url: "files.example" });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already in the dock/);
});

test("a hostile URL is refused with a reason, not silently dropped", () => {
  const result = addCustomPanel([], { url: "javascript:alert(1)" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /http:\/\/ or https:\/\//);
});

test("the dock caps how many sites can be added", () => {
  let panels = [];
  for (let index = 0; index < MAX_CUSTOM_PANELS; index += 1) {
    const result = addCustomPanel(panels, {
      url: `https://x${index}.example/`,
    });
    assert.equal(result.ok, true);
    panels = result.panels;
  }
  const overflow = addCustomPanel(panels, { url: "https://one-more.example/" });
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, new RegExp(String(MAX_CUSTOM_PANELS)));
});

test("ids are never reused after a removal", () => {
  const first = addCustomPanel([], { url: "https://a.example/" });
  const second = addCustomPanel(first.panels, { url: "https://b.example/" });
  const pruned = removeCustomPanel(second.panels, "custom:1");
  assert.equal(nextCustomPanelId(pruned), "custom:3");
});

test("custom panels round-trip through storage", () => {
  const storage = memoryStorage();
  const added = addCustomPanel([], { url: "https://a.example/", label: " A " });
  writeCustomPanels(storage, added.panels);
  assert.deepEqual(readCustomPanels(storage), [
    { id: "custom:1", label: "A", url: "https://a.example/", custom: true },
  ]);
  writeCustomPanels(storage, []);
  assert.deepEqual(readCustomPanels(storage), []);
});

test("a stored URL is RE-validated on read, not trusted", () => {
  // Hand-edited devtools storage is the threat here: a javascript: URL that
  // was written past this module must still never reach an iframe src.
  const storage = memoryStorage({
    [CUSTOM_PANELS_STORAGE_KEY]: JSON.stringify([
      { id: "custom:1", label: "evil", url: "javascript:alert(1)" },
      { id: "custom:2", label: "", url: "https://ok.example/" },
      { id: "custom:2", label: "dupe", url: "https://dupe.example/" },
      "not an object",
    ]),
  });
  assert.deepEqual(readCustomPanels(storage), [
    {
      id: "custom:2",
      label: "ok.example",
      url: "https://ok.example/",
      custom: true,
    },
  ]);
});

test("corrupt storage reads as no custom panels", () => {
  assert.deepEqual(
    readCustomPanels(memoryStorage({ [CUSTOM_PANELS_STORAGE_KEY]: "{oops" })),
    [],
  );
  assert.deepEqual(
    readCustomPanels(memoryStorage({ [CUSTOM_PANELS_STORAGE_KEY]: "42" })),
    [],
  );
  assert.deepEqual(readCustomPanels(null), []);
});

test("the built-in Files panel appears only when it has a valid URL", () => {
  const customs = addCustomPanel([], { url: "https://a.example/" }).panels;
  assert.deepEqual(
    allPanels("https://files.example/", customs).map((panel) => panel.id),
    ["files", "custom:1"],
  );
  assert.deepEqual(
    allPanels("", customs).map((panel) => panel.id),
    ["custom:1"],
  );
  assert.deepEqual(
    allPanels("javascript:alert(1)", customs).map((panel) => panel.id),
    ["custom:1"],
  );
});

test("findPanel resolves by id and tolerates null", () => {
  const panels = allPanels("https://files.example/", []);
  assert.equal(findPanel(panels, "files").label, "Files");
  assert.equal(findPanel(panels, "nope"), null);
  assert.equal(findPanel(panels, null), null);
});

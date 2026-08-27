import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement, isValidElement } from "react";

import tauriConf from "../../../src-tauri/tauri.conf.json";
import {
  E2E_BUILD_FORCES_IFRAME,
  WEB_PANELS,
  resolveRenderMode,
  showsCustomNativeNote,
} from "./webPanels.config.ts";
import {
  getWebPanel,
  resetWebPanelRegistryForTests,
} from "./webPanelRegistry.ts";

const FILES_URL = "https://crichton.tailb3d4b8.ts.net:6201/?panel=files";

function frameSrcOrigins() {
  const csp = tauriConf.app.security.csp;
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("frame-src"));
  assert.ok(directive, "tauri.conf.json csp must carry a frame-src directive");
  return directive.slice("frame-src".length).trim().split(/\s+/);
}

test("ships the files panel against the Evie file manager", () => {
  assert.equal(WEB_PANELS.length, 1);
  const files = WEB_PANELS[0];
  assert.equal(files.id, "files");
  assert.equal(files.label, "Files");
  assert.equal(files.url, FILES_URL);
});

test("panels default to native rendering outside e2e builds", () => {
  // The node test runner has no import.meta.env, so E2E_BUILD_FORCES_IFRAME
  // is false here and every configured panel must be native.
  assert.equal(E2E_BUILD_FORCES_IFRAME, false);
  for (const panel of WEB_PANELS) {
    assert.equal(
      panel.render,
      "native",
      `${panel.id} must default to native rendering`,
    );
  }
});

test("resolveRenderMode forces iframe for e2e and honors explicit fallbacks", () => {
  assert.equal(resolveRenderMode("native", true), "iframe");
  assert.equal(resolveRenderMode("iframe", true), "iframe");
  assert.equal(resolveRenderMode("native", false), "native");
  assert.equal(resolveRenderMode("iframe", false), "iframe");
});

test("showsCustomNativeNote fires only for url-less panels in forced-iframe builds", () => {
  const custom = {
    id: "site-1",
    label: "Docs",
    title: "Docs",
    icon: WEB_PANELS[0].icon,
    url: null,
    render: "native",
    custom: true,
  };
  // e2e: the note stands in for the unavailable native webview.
  assert.equal(showsCustomNativeNote(custom, true), true);
  // Production: the native child webview hosts it — no note.
  assert.equal(showsCustomNativeNote(custom, false), false);
  // Statics always have a URL for the iframe fallback.
  assert.equal(showsCustomNativeNote(WEB_PANELS[0], true), false);
  assert.equal(showsCustomNativeNote(null, true), false);
});

test("panel ids are unique", () => {
  const ids = WEB_PANELS.map((panel) => panel.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("labels, titles, ids, and icons are present", () => {
  assert.ok(WEB_PANELS.length > 0);
  for (const panel of WEB_PANELS) {
    assert.ok(panel.id, "id must be nonempty");
    assert.ok(panel.label, "label must be nonempty");
    assert.ok(panel.title, "title must be nonempty");
    // React 19 components can be objects (forwardRef), so "typeof function"
    // is the wrong bar — the real requirement is that the icon renders.
    assert.ok(
      isValidElement(createElement(panel.icon)),
      `${panel.id} icon must be a renderable component`,
    );
  }
});

test("panel urls are absolute http(s) urls", () => {
  for (const panel of WEB_PANELS) {
    const parsed = new URL(panel.url);
    assert.ok(
      parsed.protocol === "https:" || parsed.protocol === "http:",
      `${panel.id} must use http(s), got ${parsed.protocol}`,
    );
    assert.ok(parsed.hostname, `${panel.id} must name a host`);
  }
});

test("every panel origin is allowed by the CSP frame-src directive", () => {
  const allowed = frameSrcOrigins();
  for (const panel of WEB_PANELS) {
    assert.ok(
      allowed.includes(new URL(panel.url).origin),
      `${panel.id} origin missing from frame-src: ${allowed.join(" ")}`,
    );
  }
});

test("frame-src allows exactly the configured panel origins", () => {
  // The CSP is the enforcement point for iframe-fallback loading, so it
  // must not drift wider than the config: same count, no wildcards.
  const allowed = frameSrcOrigins();
  const origins = WEB_PANELS.map((panel) => new URL(panel.url).origin);
  assert.equal(allowed.length, origins.length);
  for (const entry of allowed) {
    assert.ok(
      origins.includes(entry),
      `frame-src entry ${entry} has no matching panel config`,
    );
    assert.ok(!entry.includes("*"), "frame-src must not use wildcards");
  }
});

test("getWebPanel resolves configured ids and rejects everything else", () => {
  resetWebPanelRegistryForTests();
  assert.equal(getWebPanel("files")?.url, FILES_URL);
  assert.equal(getWebPanel("nope"), null);
  assert.equal(getWebPanel(null), null);
  // Unloaded registry state must not invent custom panels.
  assert.equal(getWebPanel("site-1"), null);
});

test("rust panel table mirrors the typescript config", async () => {
  // One source of truth, proven from the TS side: the Rust PANEL_TYPES
  // table (which owns native webview URLs and the navigation allowlist)
  // must match this config exactly — same ids, same urls, same count.
  const rust = await readFile(
    new URL("../../../src-tauri/src/web_panels.rs", import.meta.url),
    "utf8",
  );
  const tableMatch = rust.match(/const PANEL_TYPES[^=]*= &\[([\s\S]*?)\];/);
  assert.ok(tableMatch, "web_panels.rs must define the PANEL_TYPES table");
  const entries = [
    ...tableMatch[1].matchAll(/"([^"]+)"\s*,\s*"[^"]+"\s*,\s*"([^"]+)"/g),
  ].map((match) => ({ id: match[1], url: match[2] }));
  assert.ok(entries.length > 0, "PANEL_TYPES must not be empty");
  assert.equal(
    entries.length,
    WEB_PANELS.length,
    "PANEL_TYPES and WEB_PANELS disagree on panel count",
  );
  for (const [index, panel] of WEB_PANELS.entries()) {
    assert.equal(
      entries[index].id,
      panel.id,
      `panel id drift at index ${index}`,
    );
    assert.equal(
      entries[index].url,
      panel.url,
      `panel url drift at index ${index}`,
    );
  }
});

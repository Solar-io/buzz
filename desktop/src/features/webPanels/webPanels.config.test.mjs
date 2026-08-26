import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, isValidElement } from "react";

import tauriConf from "../../../src-tauri/tauri.conf.json";
import { WEB_PANELS, getWebPanel } from "./webPanels.config.ts";

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
  // The CSP is the enforcement point for which remote frames may load, so it
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
  assert.equal(getWebPanel("files")?.url, FILES_URL);
  assert.equal(getWebPanel("nope"), null);
  assert.equal(getWebPanel(null), null);
});

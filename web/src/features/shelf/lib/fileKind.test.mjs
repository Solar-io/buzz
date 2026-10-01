import assert from "node:assert/strict";
import test from "node:test";

import {
  fileExtension,
  fileKind,
  hasSourceView,
  kindLabel,
  previewMode,
  readMinutes,
  readsText,
  shelfCategory,
  sourceLanguage,
} from "./fileKind.ts";

const OCTET = "application/octet-stream";

test("the extension decides first: octet-stream markdown and HTML still preview", () => {
  // The relay stores text with no magic bytes as octet-stream (D6.4).
  const table = [
    ["report.md", OCTET, "markdown", "docs", "markdown"],
    ["game-C.html", OCTET, "html", "web", "html"],
    ["Index.HTM", OCTET, "html", "web", "html"],
    ["chart.png", "image/png", "image", "images", "image"],
    ["spec.pdf", "application/pdf", "pdf", "docs", "pdf"],
    ["main.rs", OCTET, "code", "code", "code"],
    ["beats.csv", "text/csv", "data", "data", "table"],
    ["runs.tsv", OCTET, "data", "data", "table"],
    ["trace.json", "application/json", "data", "data", "code"],
    ["relay.log", OCTET, "data", "data", "text"],
    ["notes.txt", "text/plain", "text", "docs", "text"],
    ["clip.mp4", "video/mp4", "video", "other", "video"],
    ["bundle.zip", "application/zip", "other", "other", "none"],
  ];
  for (const [name, mime, kind, category, mode] of table) {
    assert.equal(fileKind(name, mime), kind, name);
    assert.equal(shelfCategory(kind), category, name);
    assert.equal(previewMode(name, kind), mode, name);
  }
  assert.equal(table.length, 13);
});

test("no usable extension: the MIME decides, and unknown bytes are a plain file", () => {
  assert.equal(fileKind("a1b2c3", "image/webp"), "image");
  assert.equal(fileKind("blob", "text/markdown"), "markdown");
  assert.equal(fileKind("blob", "text/html; charset=utf-8"), "html");
  assert.equal(fileKind("blob", "text/x-whatever"), "text");
  assert.equal(fileKind("blob", OCTET), "other");
  assert.equal(fileKind("blob", null), "other");
  assert.equal(fileExtension("archive.tar.gz"), "gz");
  assert.equal(fileExtension("README"), "");
});

test("Preview/Source exists only where the preview is a rendering", () => {
  assert.equal(hasSourceView("markdown"), true);
  assert.equal(hasSourceView("html"), true);
  assert.equal(hasSourceView("table"), true);
  assert.equal(hasSourceView("code"), false);
  assert.equal(hasSourceView("image"), false);
  assert.equal(readsText("html"), true);
  assert.equal(readsText("pdf"), false);
  assert.equal(readsText("image"), false);
});

test("labels and source languages", () => {
  assert.equal(kindLabel("markdown"), "Document");
  assert.equal(kindLabel("html"), "Web page");
  assert.equal(kindLabel("other"), "File");
  assert.equal(sourceLanguage("game-C.html"), "html");
  assert.equal(sourceLanguage("report.md"), "markdown");
  assert.equal(sourceLanguage("main.tsx"), "tsx");
  assert.equal(sourceLanguage("notes.txt"), "");
  assert.equal(readMinutes("word ".repeat(460)), 2);
  assert.equal(readMinutes(""), 1);
});

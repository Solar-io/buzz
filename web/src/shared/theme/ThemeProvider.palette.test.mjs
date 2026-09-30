import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

// The fixed-palette apply path under jsdom (web redesign Phase 0). The real
// palettes.css is loaded into the document so getComputedStyle resolves the
// palette's custom properties the way a browser would; the `@layer base`
// wrapper is unwrapped first because jsdom's CSSOM does not parse cascade
// layers (the rules inside are unchanged).
const { JSDOM } = await import("jsdom");
const dom = new JSDOM(
  '<!doctype html><html><head><meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0a0a"></head><body></body></html>',
  { url: "https://web.test/" },
);
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  getComputedStyle: globalThis.getComputedStyle,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.getComputedStyle = originals.getComputedStyle;
});

const css = readFileSync(
  new URL("../styles/palettes.css", import.meta.url),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/@layer base\s*\{([\s\S]*)\}\s*$/, "$1");
const style = dom.window.document.createElement("style");
style.textContent = css;
dom.window.document.head.appendChild(style);

const { applyAccent, applyThemeByName } = await import("./ThemeProvider.tsx");
const { DERIVED_VAR_NAMES } = await import("./adaptive-theme.ts");

const MAP = { buzz: "buzz-light", "buzz-dark": "buzz-dark" };
const root = dom.window.document.documentElement;

/** An HSL triple as numbers ("45 50 98.4") — formatting-independent. */
function numeric(triple) {
  return triple
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseFloat(part))
    .join(" ");
}

function inlineDerived() {
  return DERIVED_VAR_NAMES.filter(
    (name) => root.style.getPropertyValue(name) !== "",
  );
}

test("fixed → derived → fixed leaves no stale inline var and restores data-palette", async () => {
  assert.ok(DERIVED_VAR_NAMES.length > 20);
  const fixed = await applyThemeByName("buzz-dark", MAP);
  assert.equal(fixed.palette, "buzz-dark");
  assert.equal(root.dataset.palette, "buzz-dark");
  assert.ok(root.classList.contains("dark"));

  const derived = await applyThemeByName("catppuccin-latte", MAP);
  assert.equal(derived.palette, undefined);
  assert.equal(root.dataset.palette, undefined, "derived drops the attribute");
  assert.equal(
    inlineDerived().length,
    DERIVED_VAR_NAMES.length,
    "the engine painted every derived var inline",
  );
  assert.ok(root.classList.contains("light"));

  await applyThemeByName("buzz", MAP);
  assert.equal(root.dataset.palette, "buzz-light");
  assert.deepEqual(inlineDerived(), [], "no derived var survives inline");
  assert.ok(root.classList.contains("light"));
  const lightMeta = dom.window.document.querySelector(
    'meta[media="(prefers-color-scheme: light)"]',
  );
  assert.equal(lightMeta.getAttribute("content"), "hsl(45.0 50.00% 98.4%)");
  // The palette paints through the stylesheet, not inline.
  assert.equal(
    numeric(getComputedStyle(root).getPropertyValue("--background")),
    "45 50 98.4",
  );
});

test("accent null does not remove a palette's --primary", async () => {
  await applyThemeByName("buzz-dark", MAP);
  const before = numeric(getComputedStyle(root).getPropertyValue("--primary"));
  assert.equal(before, "40 11.11 89.4", "the palette's own --primary");
  applyAccent("#ff0000");
  assert.equal(
    numeric(getComputedStyle(root).getPropertyValue("--primary")),
    "0 100 50",
    "a user accent (inline) overrides the palette",
  );
  applyAccent(null);
  assert.equal(
    numeric(getComputedStyle(root).getPropertyValue("--primary")),
    before,
    "clearing the accent falls back to the palette, not to nothing",
  );
});

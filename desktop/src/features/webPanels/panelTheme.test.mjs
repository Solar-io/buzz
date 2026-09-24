import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM(
  '<!doctype html><html class="dark"><body></body></html>',
  {
    pretendToBeVisual: true,
    url: "http://localhost",
  },
);

let mod;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    window: dom.window,
  });
  mod = await import("./panelTheme.ts");
});

after(() => {
  dom.window.close();
});

test("normalizeThemeToken turns shadcn HSL triples into hsl() colours", () => {
  const { normalizeThemeToken } = mod;
  assert.equal(normalizeThemeToken("222 47% 11%"), "hsl(222 47% 11%)");
  assert.equal(
    normalizeThemeToken("  240 20%   14.71% "),
    "hsl(240 20% 14.71%)",
  );
  assert.equal(
    normalizeThemeToken("267deg 82.69% 79.61%"),
    "hsl(267deg 82.69% 79.61%)",
  );
  assert.equal(normalizeThemeToken("0 0% 100% / 0.5"), "hsl(0 0% 100% / 0.5)");
});

test("normalizeThemeToken passes complete colours through unchanged", () => {
  const { normalizeThemeToken } = mod;
  assert.equal(normalizeThemeToken("#1e1e2d"), "#1e1e2d");
  assert.equal(normalizeThemeToken("rgb(0, 0, 0)"), "rgb(0, 0, 0)");
  assert.equal(
    normalizeThemeToken("hsla(1, 2%, 3%, 0.4)"),
    "hsla(1, 2%, 3%, 0.4)",
  );
});

test("normalizeThemeToken drops empty, unknown, and hostile values", () => {
  const { normalizeThemeToken } = mod;
  for (const bad of [
    "",
    "   ",
    null,
    undefined,
    "red",
    "var(--x)",
    "url(javascript:alert(1))",
    "red; background: url(x)",
    "rgb(0 0 0); x",
    "10px",
    "222 47%",
  ]) {
    assert.equal(normalizeThemeToken(bad), null, String(bad));
  }
});

test("the token list is exactly the contract's sixteen", () => {
  assert.deepEqual(
    [...mod.BUZZ_THEME_TOKENS],
    [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "muted",
      "muted-foreground",
      "border",
      "input",
      "ring",
      "primary",
      "primary-foreground",
      "accent",
      "accent-foreground",
      "destructive",
    ],
  );
});

test("collectPanelTheme reads resolved vars, normalises, and derives mode from the class", () => {
  const values = {
    "--background": " 222 47% 11%",
    "--foreground": "#ffffff",
    "--primary": "267 82.69% 79.61%",
    "--border": "nonsense",
  };
  const style = { getPropertyValue: (name) => values[name] ?? "" };
  const root = dom.window.document.createElement("html");
  root.classList.add("dark");
  const payload = mod.collectPanelTheme(root, () => style);
  assert.deepEqual(payload, {
    v: 1,
    source: "buzz",
    mode: "dark",
    tokens: {
      background: "hsl(222 47% 11%)",
      foreground: "#ffffff",
      primary: "hsl(267 82.69% 79.61%)",
    },
  });
  root.classList.remove("dark");
  root.classList.add("light");
  assert.equal(mod.collectPanelTheme(root, () => style).mode, "light");
});

test("frameOrigin pins postMessage targets to the frame's own origin", () => {
  assert.equal(
    mod.frameOrigin("https://crichton.tailb3d4b8.ts.net:6201/?panel=files"),
    "https://crichton.tailb3d4b8.ts.net:6201",
  );
  assert.equal(mod.frameOrigin("about:blank"), null);
  assert.equal(mod.frameOrigin("not a url"), null);
  assert.equal(mod.frameOrigin(null), null);
});

test("postThemeToFrame posts {type:'buzz:theme', ...payload} with the frame origin", () => {
  const posted = [];
  const frame = {
    getAttribute: () => "https://stash.example:6821/",
    contentWindow: {
      postMessage: (message, origin) => posted.push([message, origin]),
    },
  };
  const payload = {
    v: 1,
    source: "buzz",
    mode: "light",
    tokens: { background: "#fff" },
  };
  assert.equal(mod.postThemeToFrame(frame, payload), true);
  assert.deepEqual(posted, [
    [{ type: "buzz:theme", ...payload }, "https://stash.example:6821"],
  ]);
  const blank = {
    getAttribute: () => "about:blank",
    contentWindow: frame.contentWindow,
  };
  assert.equal(mod.postThemeToFrame(blank, payload), false);
  assert.equal(posted.length, 1);
});

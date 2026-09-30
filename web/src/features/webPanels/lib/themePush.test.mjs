import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildThemePayload,
  CONTRACT_TOKENS,
  isFilesReady,
  isSafeColor,
  normalizeThemeToken,
  panelOrigin,
  withThemeFragment,
} from "./themePush.ts";

// Buzz web's buzz-light palette as getComputedStyle returns it on <html>
// (palettes.css, hand-copied — NOT read from the stylesheet, so a palette
// edit cannot silently re-baseline this test). `--sidebar-row-*` style values
// are left out on purpose: they are not colours the contract carries.
const BUZZ_LIGHT = {
  "--background": " 45 50.00% 98.4%",
  "--foreground": "48 10.20% 9.6%",
  "--card": "0 0% 100.0%",
  "--card-foreground": "48 10.20% 9.6%",
  "--popover": "0 0% 100.0%",
  "--popover-foreground": "48 10.20% 9.6%",
  "--muted": "42 27.78% 92.9%",
  "--muted-foreground": "38.8 8.63% 38.6%",
  "--border": "42.9 21.88% 87.5%",
  "--input": "42.4 17.17% 80.6%",
  "--ring": "48 10.20% 9.6%",
  "--primary": "48 10.20% 9.6%",
  "--primary-foreground": "45 50.00% 98.4%",
  "--accent": "42 31.25% 93.7%",
  "--accent-foreground": "48 10.20% 9.6%",
  "--destructive": "9.8 72.81% 55.3%",
  "--rail": "42.9 30.43% 95.5%",
  "--sidebar-background": "42 27.78% 92.9%",
  "--sidebar-active": "48 10.20% 9.6%",
  "--sidebar-active-foreground": "45 50.00% 98.4%",
  "--sel": "41.5 28.89% 91.2%",
  "--sel-foreground": "48 10.20% 9.6%",
};
const reader = (vars) => (name) => vars[name] ?? "";

test("buzz-light becomes the exact contract-v1 payload", () => {
  assert.deepEqual(buildThemePayload(reader(BUZZ_LIGHT), false), {
    type: "buzz:theme",
    v: 1,
    source: "buzz",
    mode: "light",
    tokens: {
      background: "hsl(45 50.00% 98.4%)",
      foreground: "hsl(48 10.20% 9.6%)",
      card: "hsl(0 0% 100.0%)",
      "card-foreground": "hsl(48 10.20% 9.6%)",
      popover: "hsl(0 0% 100.0%)",
      "popover-foreground": "hsl(48 10.20% 9.6%)",
      muted: "hsl(42 27.78% 92.9%)",
      "muted-foreground": "hsl(38.8 8.63% 38.6%)",
      border: "hsl(42.9 21.88% 87.5%)",
      input: "hsl(42.4 17.17% 80.6%)",
      ring: "hsl(48 10.20% 9.6%)",
      primary: "hsl(48 10.20% 9.6%)",
      "primary-foreground": "hsl(45 50.00% 98.4%)",
      accent: "hsl(42 31.25% 93.7%)",
      "accent-foreground": "hsl(48 10.20% 9.6%)",
      destructive: "hsl(9.8 72.81% 55.3%)",
      sidebar: "hsl(42.9 30.43% 95.5%)",
      "sidebar-active": "hsl(41.5 28.89% 91.2%)",
      "sidebar-active-foreground": "hsl(48 10.20% 9.6%)",
    },
  });
});

test("polarity comes from the root's dark class, not from the colours", () => {
  assert.equal(buildThemePayload(reader(BUZZ_LIGHT), true).mode, "dark");
  assert.equal(buildThemePayload(reader({}), false).mode, "light");
});

test("the sixteen contract tokens, in order", () => {
  assert.deepEqual(
    [...CONTRACT_TOKENS],
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

test("a derived theme without --sel sends Buzz's own selected-row pair", () => {
  const vars = { ...BUZZ_LIGHT };
  delete vars["--sel"];
  delete vars["--sel-foreground"];
  delete vars["--rail"];
  vars["--sidebar-active"] = "266 85.05% 58.04%";
  vars["--sidebar-active-foreground"] = "220 23.08% 94.9%";
  const { tokens } = buildThemePayload(reader(vars), false);
  assert.equal(tokens["sidebar-active"], "hsl(266 85.05% 58.04%)");
  assert.equal(tokens["sidebar-active-foreground"], "hsl(220 23.08% 94.9%)");
  assert.equal(
    tokens.sidebar,
    "hsl(42 27.78% 92.9%)",
    "no --rail: the sidebar background",
  );
});

test("a fill is never sent without its ink", () => {
  const vars = { ...BUZZ_LIGHT };
  delete vars["--sel"];
  vars["--sidebar-active-foreground"] = "not a colour";
  const { tokens } = buildThemePayload(reader(vars), false);
  assert.equal("sidebar-active" in tokens, false);
  assert.equal("sidebar-active-foreground" in tokens, false);
});

test("a hostile or unknown value is dropped, never forwarded", () => {
  const vars = {
    ...BUZZ_LIGHT,
    "--background": "red;} body{display:none",
    "--card": "url(https://evil.test/x.png)",
    "--muted": "var(--x)",
    "--border": "red",
  };
  const { tokens } = buildThemePayload(reader(vars), false);
  for (const token of ["background", "card", "muted", "border"]) {
    assert.equal(token in tokens, false, token);
  }
  assert.equal(tokens.foreground, "hsl(48 10.20% 9.6%)", "the rest survive");
});

test("normalizeThemeToken: triples wrap, complete colours pass, the rest drop", () => {
  assert.equal(normalizeThemeToken("222 47% 11%"), "hsl(222 47% 11%)");
  assert.equal(
    normalizeThemeToken("  240 20%   14.71% "),
    "hsl(240 20% 14.71%)",
  );
  assert.equal(normalizeThemeToken("0 0% 100% / 0.5"), "hsl(0 0% 100% / 0.5)");
  assert.equal(normalizeThemeToken("#1e1e2d"), "#1e1e2d");
  assert.equal(
    normalizeThemeToken("rgb(255 255 255 / 0.05)"),
    "rgb(255 255 255 / 0.05)",
  );
  for (const bad of [
    "",
    null,
    undefined,
    "red",
    "10px",
    "222 47%",
    "rgb(0 0 0); x",
    "hsl(from red h s l)",
    "rgb(calc(1) 0 0)",
    `hsl(${"1".repeat(70)} 0% 0%)`,
  ]) {
    assert.equal(normalizeThemeToken(bad), null, String(bad));
  }
});

test("everything we emit passes stash's strict colour grammar", () => {
  const payload = buildThemePayload(reader(BUZZ_LIGHT), false);
  const values = Object.values(payload.tokens);
  assert.equal(values.length, 19, "all nineteen tokens present");
  for (const value of values) {
    assert.ok(isSafeColor(value), value);
    assert.ok(value.length <= 64, value);
  }
});

test("panelOrigin is the panel's exact origin, and null for anything else", () => {
  assert.equal(
    panelOrigin("https://crichton.tailb3d4b8.ts.net:6831/?path=/x#y"),
    "https://crichton.tailb3d4b8.ts.net:6831",
  );
  assert.equal(panelOrigin("http://files.test/"), "http://files.test");
  assert.equal(panelOrigin("about:blank"), null);
  assert.equal(panelOrigin("not a url"), null);
  assert.equal(panelOrigin(null), null);
});

test("isFilesReady matches stash's boot announcement only", () => {
  assert.equal(isFilesReady({ type: "files:ready", v: 1 }), true);
  assert.equal(isFilesReady({ type: "buzz:theme" }), false);
  assert.equal(isFilesReady("files:ready"), false);
  assert.equal(isFilesReady(null), false);
});

test("withThemeFragment carries the contract body, base64url, no padding", () => {
  const payload = buildThemePayload(reader(BUZZ_LIGHT), false);
  const url = withThemeFragment(
    "https://crichton.tailb3d4b8.ts.net:6831/?theme=light#old",
    payload,
  );
  const parsed = new URL(url);
  assert.equal(parsed.search, "?theme=light");
  const encoded = parsed.hash.slice("#buzz-theme=".length);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, "stash's one character check");
  const json = Buffer.from(
    encoded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
  const body = JSON.parse(json);
  assert.equal(body.type, undefined, "the fragment is the payload body");
  assert.equal(body.v, 1);
  assert.equal(body.mode, "light");
  assert.equal(body.tokens.background, "hsl(45 50.00% 98.4%)");
  assert.ok(json.length <= 4096, `${json.length} bytes`);
});

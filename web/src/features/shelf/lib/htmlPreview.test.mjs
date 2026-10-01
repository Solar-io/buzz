import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HtmlPreview } from "../ui/HtmlPreview.tsx";
import { HTML_PREVIEW_SANDBOX, htmlPreviewFrame } from "./htmlPreview.ts";

const PAGE =
  "<!doctype html><title>game</title><script>document.title='ran'</script>";

test("the preview frame's sandbox is exactly allow-scripts", () => {
  const frame = htmlPreviewFrame(PAGE);
  // Hardcoded: the value under test is the constant, so the constant cannot
  // be the expectation.
  assert.equal(frame.sandbox, "allow-scripts");
  assert.equal(HTML_PREVIEW_SANDBOX, "allow-scripts");
  const tokens = frame.sandbox.split(/\s+/);
  for (const forbidden of [
    "allow-same-origin",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
    "allow-forms",
    "allow-modals",
  ]) {
    assert.equal(tokens.includes(forbidden), false, forbidden);
  }
  assert.equal(frame.srcDoc, PAGE);
  assert.equal(frame.referrerPolicy, "no-referrer");
});

test("the rendered iframe carries the bytes as srcdoc and never a src", () => {
  const markup = renderToStaticMarkup(
    createElement(HtmlPreview, { html: PAGE, title: "game-C.html" }),
  );
  assert.match(markup, /^<iframe /);
  assert.match(markup, / sandbox="allow-scripts"/);
  assert.doesNotMatch(markup, /allow-same-origin/);
  assert.doesNotMatch(markup, / src="/);
  assert.match(markup, / srcDoc="|srcdoc="/i);
  assert.match(
    markup,
    /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i,
  );
});

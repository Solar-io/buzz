import assert from "node:assert/strict";
import { after, test } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  stubs: globalThis.__BUZZ_TEST_MODULE_STUBS__,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Only application services are stubbed; the shipped MarkdownContent,
// react-markdown, parser, plugins and rendered markdown elements are real.
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@/features/custom-emoji/hooks":
    "export function useCustomEmoji() { return []; }",
  "@/features/agents/ui/SnapshotPreviewProvider":
    "export function useSnapshotPreview() { return null; }",
  "@/shared/ui/FileViewerDialog":
    "export function useFileViewer() { return null; }",
  "@/shared/api/RelaySessionProvider": `
    export function useRelaySession() {
      return { session: { subscribe: () => () => {} }, status: "open" };
    }
  `,
};
const { MarkdownContent } = await import("./MarkdownContent.tsx");

after(() => {
  globalThis.window = originals.window;
  globalThis.document = originals.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = originals.actEnv;
  globalThis.__BUZZ_TEST_MODULE_STUBS__ = originals.stubs;
  dom.window.close();
});

async function render(content, verify) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(MarkdownContent, {
          content,
          mentionNames: new Set(["alice"]),
        }),
      ),
    );
    verify(host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

for (const [name, content] of [
  [
    "blank-line",
    "<details><summary>🌌 **Updates** @alice</summary>\n\n- a\n- b\n\n</details>",
  ],
  [
    "single-node",
    "<details><summary>🌌 **Updates** @alice</summary>\n- a\n- b\n</details>",
  ],
]) {
  test(`MarkdownContent details: ${name} message renders closed DOM with a formatted summary and list`, async () => {
    await render(content, (host) => {
      const details = host.querySelector("details");
      assert.ok(details);
      assert.equal(details.open, false);
      const summary = host.querySelector("details > summary");
      assert.ok(summary);
      assert.equal(summary.textContent, "🌌 Updates @alice");
      assert.equal(summary.querySelector("strong").textContent, "Updates");
      assert.equal(
        summary.querySelector(".text-accent-foreground").textContent,
        "@alice",
      );
      assert.deepEqual(
        [...host.querySelectorAll("details > ul > li")].map(
          (li) => li.textContent,
        ),
        ["a", "b"],
      );
      assert.ok(summary.classList.contains("cursor-pointer"));
      assert.ok(summary.classList.contains("list-item"));
      assert.ok(details.className.includes("mt-2"));
      assert.doesNotMatch(host.innerHTML, /&lt;\/?(?:details|summary)/);
    });
  });
}

test("MarkdownContent details: open is expanded and other HTML stays literal", async () => {
  await render(
    "<details open><summary>X</summary>\n\n<div>hi</div>\n\n</details>\n\n<script>alert(1)</script>",
    (host) => {
      assert.equal(host.querySelector("details").open, true);
      assert.ok(host.textContent.includes("<div>hi</div>"));
      assert.ok(host.textContent.includes("<script>alert(1)</script>"));
      assert.equal(host.querySelector("script"), null);
    },
  );
});

test("MarkdownContent details: re-parsed body keeps spoilers, callouts and GFM tables", async () => {
  await render(
    "<details><summary>X</summary>\n> [!NOTE]\n> useful\n\n||secret||\n\n| Name |\n| --- |\n| **a** |\n\n</details>",
    (host) => {
      assert.equal(
        host
          .querySelector("details [data-callout=note]")
          .textContent.includes("useful"),
        true,
      );
      assert.equal(
        host.querySelector('details button[aria-label="Reveal hidden text"]')
          .textContent,
        "secret",
      );
      assert.equal(
        host.querySelector("details table tbody td strong").textContent,
        "a",
      );
    },
  );
});

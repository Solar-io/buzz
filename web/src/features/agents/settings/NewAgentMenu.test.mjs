import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dom, mount, button, act } from "./w11aTestSupport.mjs";
const { NewAgentMenu } = await import("./NewAgentMenu.tsx");
const { LibraryTabs } = await import("./LibraryTabs.tsx");
const { desktopCatalogFromEvent } = await import("../lib/desktopCatalog.ts");
after(() => dom.window.close());

async function open(container) {
  await act(async () =>
    button(container, "New agent").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
}
function item(name) {
  const result = Array.from(
    document.querySelectorAll('[role="menuitem"]'),
  ).find((el) => el.textContent.startsWith(name));
  assert.ok(result, `Missing ${name}`);
  return result;
}
test("From a definition is locked with update copy without create.linked", async () => {
  let blank = 0;
  await mount(
    NewAgentMenu,
    { catalogs: [], onBlank: () => blank++ },
    async (container) => {
      await open(container);
      const entry = item("From a definition");
      assert.equal(entry.getAttribute("aria-disabled"), "true");
      assert.match(entry.textContent, /Update Buzz Desktop/);
      await act(() => entry.click());
      assert.equal(blank, 0);
      assert.equal(document.querySelectorAll('[role="menuitem"]').length, 4);
      await act(() => item("Blank agent").click());
      assert.equal(blank, 1);
    },
  );
});
test("From a team stays locked until P2 even with its named v5 capability", async () => {
  await mount(
    NewAgentMenu,
    {
      catalogs: [{ version: 5, caps: ["create.linked", "create.team"] }],
      onBlank() {},
    },
    async (container) => {
      await open(container);
      for (const name of ["From a definition", "From a team"]) {
        assert.equal(item(name).getAttribute("aria-disabled"), "true");
        assert.match(
          item(name).textContent,
          /Coming in the next creation update/,
        );
      }
    },
  );
});
test("a pre-v5 capability list cannot suppress the update explanation", async () => {
  await mount(
    NewAgentMenu,
    { catalogs: [{ version: 4, caps: ["create.linked"] }], onBlank() {} },
    async (container) => {
      await open(container);
      assert.match(
        item("From a definition").textContent,
        /Update Buzz Desktop/,
      );
    },
  );
});
test("snapshot file input survives closing the New agent menu and opens the existing preview", async () => {
  const imports = [];
  globalThis.__W11A_IMPORT__ = (...args) => imports.push(args);
  await mount(
    NewAgentMenu,
    { catalogs: [], onBlank() {} },
    async (container) => {
      await open(container);
      await act(() => item("Import snapshot").click());
      const input = container.querySelector(
        '[data-testid="web-import-snapshot-input"]',
      );
      assert.ok(input, "input lives outside the unmounted menu");
      Object.defineProperty(input, "files", {
        value: [
          {
            name: "sample.agent.json",
            size: 3,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          },
        ],
      });
      await act(async () =>
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true })),
      );
      assert.deepEqual(imports, [
        ["sample.agent.json", new Uint8Array([1, 2, 3])],
      ]);
    },
  );
});
test("catalog reader retains only string capabilities for named creation locks", () => {
  const catalog = desktopCatalogFromEvent({
    kind: 30180,
    created_at: 1,
    tags: [["d", "test"]],
    content: JSON.stringify({
      format: "buzz-desktop-catalog",
      version: 5,
      machine: "test",
      updated_at: 1,
      caps: ["create.linked", 42, null],
    }),
  });
  assert.deepEqual(catalog.caps, ["create.linked"]);
});
test("Library tabs include Snapshots and support keyboard navigation", async () => {
  const changes = [];
  await mount(
    LibraryTabs,
    { value: "definitions", onChange: (tab) => changes.push(tab) },
    async (container) => {
      assert.deepEqual(
        Array.from(container.querySelectorAll('[role="tab"]')).map(
          (el) => el.textContent,
        ),
        ["Definitions", "Teams", "Catalog", "Snapshots"],
      );
      await act(() => button(container, "Snapshots").click());
      await act(() =>
        button(container, "Definitions").dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "End",
            bubbles: true,
          }),
        ),
      );
      assert.deepEqual(changes, ["snapshots", "snapshots"]);
      assert.equal(document.activeElement.textContent, "Snapshots");
    },
  );
});

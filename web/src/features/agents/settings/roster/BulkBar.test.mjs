import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { runRosterActions, rosterActionAllowed } from "../lib/rosterActions.ts";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BulkBar } = await import("./BulkBar.tsx");
after(() => dom.window.close());
const row = (key, machine = "crichton.local") => ({
  pubkey: key,
  name: key,
  machines: machine ? [machine] : [],
});
const catalogs = [
  { machine: "crichton.local", version: 4, updatedAt: Date.now() / 1000 },
  { machine: "second.local", version: 2, updatedAt: Date.now() / 1000 },
];
async function fixture(props, run) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(() =>
      root.render(
        h(BulkBar, {
          busy: false,
          cleanupKeys: new Set(),
          catalogs,
          onAdd() {},
          onClear() {},
          ...props,
        }),
      ),
    );
    await run(node);
  } finally {
    await act(() => root.unmount());
    node.remove();
  }
}
test("bulk Restart sends one restart per selected agent targeted at its machine", async () => {
  const calls = [];
  let pending;
  await fixture(
    {
      selected: [row("a"), row("b", "second.local")],
      onAction: (action, rows) => {
        pending = runRosterActions(rows, action, async (...args) => {
          calls.push(args);
          return { ok: true };
        });
      },
    },
    async (node) => {
      await act(() =>
        [...node.querySelectorAll("button")]
          .find((button) => button.textContent === "Restart")
          .click(),
      );
      await pending;
      assert.deepEqual(
        calls.map(([command, , options]) => [command, options]),
        [
          [
            { action: "restart", request: { pubkey: "a" } },
            { target: "crichton.local" },
          ],
          [
            { action: "restart", request: { pubkey: "b" } },
            { target: "second.local" },
          ],
        ],
      );
    },
  );
});
test("bulk Start and Stop use their exact existing lifecycle actions", async () => {
  for (const action of ["start", "stop"]) {
    const calls = [];
    await runRosterActions([row("a"), row("b")], action, async (command) => {
      calls.push(command);
      return { ok: true };
    });
    assert.deepEqual(
      calls,
      ["a", "b"].map((pubkey) => ({ action, request: { pubkey } })),
    );
  }
});
test("bulk partial refusal preserves peer success and quotes the desktop error", async () => {
  const receipts = await runRosterActions(
    [row("a"), row("b")],
    "stop",
    async (command) =>
      command.request.pubkey === "a"
        ? { ok: false, error: "Refused exactly" }
        : { ok: true },
  );
  assert.deepEqual(
    receipts.map(({ ok, message }) => [ok, message]),
    [
      [false, "Refused exactly"],
      [true, "Applied on Buzz Desktop"],
    ],
  );
});
test("bulk lifecycle never broadcasts an unclaimed or multiply claimed agent", async () => {
  let calls = 0;
  const receipts = await runRosterActions(
    [row("a", null), { ...row("b"), machines: ["a", "b"] }],
    "restart",
    async () => {
      calls++;
      return { ok: true };
    },
  );
  assert.equal(calls, 0);
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((receipt) => !receipt.ok));
});
test("bulk lifecycle deduplicates keys and bounds concurrency at three", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const receipts = await runRosterActions(
    [row("a"), row("a"), ...["b", "c", "d", "e"].map((key) => row(key))],
    "start",
    async (command) => {
      calls.push(command.request.pubkey);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { ok: true };
    },
  );
  assert.equal(peak, 3);
  assert.equal(receipts.length, 5);
  assert.equal(new Set(calls).size, 5);
});
test("Unregister retains the authoritative-catalog safety guard and never deletes a key", async () => {
  const stale = row("stale", null);
  assert.equal(
    rosterActionAllowed(stale, "unregister", new Set(), true),
    false,
  );
  assert.equal(
    rosterActionAllowed(stale, "unregister", new Set(["stale"]), true),
    true,
  );
  assert.equal(
    rosterActionAllowed(row("stale"), "unregister", new Set(["stale"]), true),
    false,
  );
  const calls = [];
  await runRosterActions([stale], "unregister", async (...args) => {
    calls.push(args);
    return { ok: true };
  });
  assert.deepEqual(calls[0][0], {
    action: "unregister",
    request: { pubkey: "stale" },
  });
  assert.deepEqual(calls[0][2], {});
});
test("bulk toolbar locks mixed selections, old restart targets and busy commands", async () => {
  for (const props of [
    { selected: [row("a"), row("b", null)] },
    {
      selected: [row("a")],
      catalogs: [{ machine: "crichton.local", version: 1 }],
    },
    { selected: [row("a")], busy: true },
    {
      selected: [row("a")],
      catalogs: [{ ...catalogs[0], updatedAt: Date.now() / 1000 - 8 * 3600 }],
    },
  ])
    await fixture(
      {
        onAction() {
          throw new Error("must stay disabled");
        },
        ...props,
      },
      async (node) => {
        const button = [...node.querySelectorAll("button")].find(
          (button) => button.textContent === "Restart",
        );
        assert.equal(button.disabled, true);
        await act(() => button.click());
      },
    );
});

test("Unregister locks when all desktop reports are stale", async () => {
  await fixture(
    {
      selected: [row("stale", null)],
      cleanupKeys: new Set(["stale"]),
      catalogs: [{ ...catalogs[0], updatedAt: Date.now() / 1000 - 8 * 3600 }],
      onAction() {
        throw new Error("must not send while offline");
      },
    },
    async (node) => {
      const button = [...node.querySelectorAll("button")].find(
        (button) => button.textContent === "Unregister",
      );
      assert.equal(button.disabled, true);
      await act(() => button.click());
    },
  );
});

test("desktop presence locks every bulk lifecycle action and stale unregister", async () => {
  for (const selected of [[row("a")], [row("stale", null)]]) {
    await fixture(
      {
        selected,
        cleanupKeys: new Set(["stale"]),
        controlLock: { locked: true, reason: "Needs the desktop" },
        onAction() {
          assert.fail("locked action must not send");
        },
      },
      async (node) => {
        for (const action of ["Start", "Stop", "Restart", "Unregister"]) {
          const button = [...node.querySelectorAll("button")].find(
            (button) => button.textContent === action,
          );
          assert.ok(button, `${action} control exists`);
          assert.equal(button.disabled, true, action);
          assert.equal(button.title, "Needs the desktop");
          await act(() => button.click());
        }
      },
    );
  }
});

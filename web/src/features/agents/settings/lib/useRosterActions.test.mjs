import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRosterActions } = await import("./useRosterActions.ts");
after(() => dom.window.close());
const row = (pubkey) => ({
  pubkey,
  name: pubkey,
  machines: ["crichton.local"],
});

async function fixture(send, run) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let api;
  let unmounted = false;
  function Probe({ acks }) {
    api = useRosterActions({ send, acks });
    return null;
  }
  const render = (acks = new Map()) =>
    act(() => root.render(h(Probe, { acks })));
  const unmount = async () => {
    if (!unmounted) {
      unmounted = true;
      await act(() => root.unmount());
    }
  };
  try {
    await render();
    await run({ get: () => api, render, unmount });
  } finally {
    await unmount();
    node.remove();
  }
}

test("roster receipts wait for application acknowledgements and quote refusals", async () => {
  await fixture(
    async (command) => command.request.pubkey,
    async ({ get, render }) => {
      let pending;
      await act(() => {
        pending = get().run("restart", [row("a"), row("b")]);
      });
      assert.equal(get().busy, true);
      assert.deepEqual(get().receipts, []);
      await render(new Map([["a", { ok: true }]]));
      assert.equal(get().busy, true);
      await act(async () => {
        await render(
          new Map([
            ["a", { ok: true }],
            ["b", { ok: false, error: "Exact refusal" }],
          ]),
        );
        await pending;
      });
      assert.equal(get().busy, false);
      assert.deepEqual(
        get().receipts.map(({ ok, message }) => [ok, message]),
        [
          [true, "Applied on Buzz Desktop"],
          [false, "Exact refusal"],
        ],
      );
    },
  );
});

test("roster uses an acknowledgement that arrived before send resolved", async () => {
  await fixture(
    async () => "early",
    async ({ get, render }) => {
      await render(new Map([["early", { ok: true }]]));
      await act(() => get().run("stop", [row("a")]));
      assert.equal(get().receipts[0].ok, true);
      assert.equal(get().busy, false);
    },
  );
});

test("roster timeout is thirty seconds and reports uncertainty rather than success", async () => {
  const original = window.setTimeout;
  let expire;
  let delay;
  window.setTimeout = (callback, ms) => {
    expire = callback;
    delay = ms;
    return 123;
  };
  try {
    await fixture(
      async () => "timeout",
      async ({ get }) => {
        let pending;
        await act(() => {
          pending = get().run("start", [row("a")]);
        });
        assert.equal(delay, 30_000);
        await act(async () => {
          expire();
          await pending;
        });
        assert.equal(get().receipts[0].ok, false);
        assert.equal(
          get().receipts[0].message,
          "No answer from crichton — it may still apply. Check status after reload.",
        );
      },
    );
  } finally {
    window.setTimeout = original;
  }
});

test("closing the roster settles waits and stops unsent batch commands", async () => {
  const calls = [];
  await fixture(
    async (command) => {
      calls.push(command.request.pubkey);
      return command.request.pubkey;
    },
    async ({ get, unmount }) => {
      let pending;
      await act(() => {
        pending = get().run("restart", ["a", "b", "c", "d", "e"].map(row));
      });
      assert.equal(calls.length, 3);
      await unmount();
      await pending;
      assert.deepEqual(calls, ["a", "b", "c"]);
    },
  );
});

test("closing during relay publication does not install an abandoned ack wait", async () => {
  let finishSend;
  await fixture(
    () =>
      new Promise((resolve) => {
        finishSend = resolve;
      }),
    async ({ get, unmount }) => {
      let pending;
      await act(() => {
        pending = get().run("stop", [row("a")]);
      });
      await unmount();
      finishSend("late");
      await pending;
    },
  );
});

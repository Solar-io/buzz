import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * `?m=` may leave the URL only once the jump LANDED. Clearing it earlier ends
 * the jump (the timeline's target derives from `m`) — the live #general bug
 * dropped it 800ms after the target merely entered the buffer, while the
 * list sat on a stale row.
 */
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { usePermalinkCleanup } = await import("./usePermalinkCleanup.ts");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(initial) {
  const calls = [];
  const navigate = async (to) => {
    calls.push(to);
  };
  const out = { onSettled: null };
  function Probe(props) {
    out.onSettled = usePermalinkCleanup({ ...props, navigate });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (props) => {
    await act(async () => {
      root.render(React.createElement(Probe, props));
    });
  };
  await render(initial);
  return {
    calls,
    render,
    settle: (id) => act(async () => out.onSettled(id)),
    elapse: (ms) => act(async () => wait(ms)),
    unmount: () => act(async () => root.unmount()),
  };
}

const BASE = {
  permalinkMessageId: "m1",
  permalinkReady: true,
  selectedId: "c1",
};

test("target in the buffer but not landed: m stays past the old 800ms clear", async () => {
  const view = await mount(BASE);
  await view.elapse(1200);
  assert.deepEqual(
    view.calls,
    [],
    "nothing may clear m before the jump settles",
  );
  await view.unmount();
});

test("settled on the permalink id: m is cleared ~800ms later, channel kept", async () => {
  const view = await mount(BASE);
  await view.settle("m1");
  await view.elapse(300);
  assert.deepEqual(view.calls, [], "the flash gets its 800ms first");
  await view.elapse(700);
  assert.deepEqual(view.calls, [
    { to: "/repos", search: { c: "c1" }, replace: true },
  ]);
  await view.unmount();
});

test("a settle for a DIFFERENT id (a reply's thread root) does not clear m", async () => {
  const view = await mount(BASE);
  await view.settle("root-of-m1");
  await view.elapse(1200);
  assert.deepEqual(view.calls, []);
  await view.unmount();
});

test("never settles: the fallback still drops the dead m", async () => {
  const view = await mount({ ...BASE, permalinkReady: false });
  await view.elapse(4300);
  assert.equal(view.calls.length, 1, "cleared once by the fallback");
  await view.unmount();
});

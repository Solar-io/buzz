import assert from "node:assert/strict";
import { test, after } from "node:test";

// useThreadPaneWidth under jsdom + act. ResizeObserver does not exist in
// jsdom, so a stub is installed and inspected DIRECTLY: the assertions are
// about what the hook actually observed, not about the code's text (a
// source scan here would have missed the late-mount defect entirely — QA
// 2026-09-14 found it behaviorally for exactly that reason).
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test/",
});
const originals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  actEnv: globalThis.IS_REACT_ACT_ENVIRONMENT,
  innerHeight: globalThis.innerHeight,
  resizeObserver: globalThis.ResizeObserver,
  addEventListener: globalThis.addEventListener,
  removeEventListener: globalThis.removeEventListener,
};
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.innerHeight = 800;
// The hook targets globalThis.* (=== window in the app); node's global has
// no listener API, so bridge to the jsdom window.
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(
  dom.window,
);

class ResizeObserverStub {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    ResizeObserverStub.instances.push(this);
  }
  observe(element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}
globalThis.ResizeObserver = ResizeObserverStub;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useThreadPaneWidth } = await import("./useThreadPaneWidth.ts");

function Harness({
  channelId = "chan-1",
  railVisible = false,
  rowVisible = true,
}) {
  const { setRowEl } = useThreadPaneWidth(channelId, railVisible);
  return rowVisible
    ? React.createElement("div", { ref: setRowEl, "data-testid": "row" })
    : null;
}

async function mountHarness(props) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const render = (nextProps) =>
    act(async () => {
      root.render(React.createElement(Harness, nextProps));
    });
  await render(props);
  return {
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const observedRow = (instance) =>
  instance?.observed[0]?.getAttribute?.("data-testid");

test("the observer attaches when the row exists at mount", async () => {
  ResizeObserverStub.instances = [];
  const harness = await mountHarness({});

  assert.equal(ResizeObserverStub.instances.length, 1, "one observer");
  const [observer] = ResizeObserverStub.instances;
  assert.equal(observedRow(observer), "row", "it observes THE row");
  assert.equal(observer.disconnected, false);

  await harness.unmount();
  assert.equal(observer.disconnected, true, "cleanup disconnects");
});

test("the observer attaches when the row mounts LATER (view → channel)", async () => {
  ResizeObserverStub.instances = [];
  // Landing on files/workflows/inbox: the shell renders no layout row.
  const harness = await mountHarness({ rowVisible: false });
  assert.equal(
    ResizeObserverStub.instances.length,
    0,
    "no row → no observer, and no crash",
  );

  // Opening a channel mounts the row; the effect must re-run and observe.
  await harness.render({ rowVisible: true });

  assert.equal(
    ResizeObserverStub.instances.length,
    1,
    "exactly one observer after the row appears",
  );
  assert.equal(
    observedRow(ResizeObserverStub.instances[0]),
    "row",
    "the late-mounted row IS observed",
  );
  await harness.unmount();
});

after(() => {
  Object.assign(globalThis, {
    window: originals.window,
    document: originals.document,
    IS_REACT_ACT_ENVIRONMENT: originals.actEnv,
    innerHeight: originals.innerHeight,
    ResizeObserver: originals.resizeObserver,
    addEventListener: originals.addEventListener,
    removeEventListener: originals.removeEventListener,
  });
  if (originals.navigator) {
    Object.defineProperty(globalThis, "navigator", originals.navigator);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  FLOATING_POSITION_KEY,
  PANEL_MARGIN,
  clampPanelPosition,
  defaultPanelPosition,
  loadPanelPosition,
  savePanelPosition,
} = await import("./floatingPosition.ts");

const VIEWPORT = { width: 1280, height: 800 };
const SIZE = { width: 380, height: 520 };

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
  };
}

test("the default position is bottom-right, one margin in", () => {
  assert.deepEqual(defaultPanelPosition(VIEWPORT, SIZE), {
    x: 1280 - 380 - PANEL_MARGIN,
    y: 800 - 520 - PANEL_MARGIN,
  });
});

test("a position past any edge is pulled back inside the viewport", () => {
  assert.deepEqual(clampPanelPosition({ x: -500, y: -500 }, VIEWPORT, SIZE), {
    x: PANEL_MARGIN,
    y: PANEL_MARGIN,
  });
  assert.deepEqual(clampPanelPosition({ x: 9_000, y: 9_000 }, VIEWPORT, SIZE), {
    x: 1280 - 380 - PANEL_MARGIN,
    y: 800 - 520 - PANEL_MARGIN,
  });
  // A position already inside is left alone.
  assert.deepEqual(clampPanelPosition({ x: 200, y: 120 }, VIEWPORT, SIZE), {
    x: 200,
    y: 120,
  });
});

test("a panel bigger than the window keeps its top-left corner on screen", () => {
  // The lower bound would exceed the upper one here; the margin has to win,
  // or the drag handle ends up above the top of the window and the panel
  // can never be moved or closed again.
  const tiny = { width: 300, height: 300 };
  assert.deepEqual(clampPanelPosition({ x: 50, y: 50 }, tiny, SIZE), {
    x: PANEL_MARGIN,
    y: PANEL_MARGIN,
  });
});

test("a position saved on a big monitor is clamped when loaded on a small one", () => {
  // THE reason clamping happens on read: the stored value is perfectly
  // valid on a 2560px display and entirely off-screen on a laptop.
  const store = memoryStore();
  savePanelPosition(store, { x: 2_100, y: 1_300 });
  assert.equal(store.map.size, 1);
  assert.ok(store.map.has(FLOATING_POSITION_KEY));
  const loaded = loadPanelPosition(store, VIEWPORT, SIZE);
  assert.deepEqual(loaded, {
    x: 1280 - 380 - PANEL_MARGIN,
    y: 800 - 520 - PANEL_MARGIN,
  });
  assert.ok(loaded.x + SIZE.width <= VIEWPORT.width, "fully on screen");
  assert.ok(loaded.y + SIZE.height <= VIEWPORT.height, "fully on screen");
});

test("a usable saved position round-trips", () => {
  const store = memoryStore();
  savePanelPosition(store, { x: 240, y: 130 });
  assert.deepEqual(loadPanelPosition(store, VIEWPORT, SIZE), {
    x: 240,
    y: 130,
  });
});

test("nothing stored, malformed, or a hostile store all fall back to the default", () => {
  const expected = defaultPanelPosition(VIEWPORT, SIZE);
  assert.deepEqual(loadPanelPosition(memoryStore(), VIEWPORT, SIZE), expected);
  for (const raw of [
    "",
    "not json",
    "null",
    '{"x":"left","y":3}',
    '{"x":null}',
  ]) {
    assert.deepEqual(
      loadPanelPosition(
        memoryStore({ [FLOATING_POSITION_KEY]: raw }),
        VIEWPORT,
        SIZE,
      ),
      expected,
      `malformed payload ${JSON.stringify(raw)}`,
    );
  }
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadPanelPosition(throwing, VIEWPORT, SIZE), expected);
  assert.doesNotThrow(() => savePanelPosition(throwing, { x: 1, y: 2 }));
  assert.deepEqual(loadPanelPosition(null, VIEWPORT, SIZE), expected);
});

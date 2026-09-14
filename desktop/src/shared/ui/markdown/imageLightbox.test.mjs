import assert from "node:assert/strict";
import { test } from "node:test";

// imageLightboxTargetBox reads window.innerWidth/innerHeight at call time —
// stub the viewport per test, not at import time.
//
// Expectations below are HARDCODED against the "full size" contract from the
// 9/14 report (photo fills 92% of the constrained viewport side). Do not
// restate them in terms of IMAGE_LIGHTBOX_BASE_VIEWPORT_RATIO — an assertion
// derived from the constant it pins cannot fail when the constant regresses.
function withViewport(width, height, run) {
  const previous = globalThis.window;
  globalThis.window = { innerWidth: width, innerHeight: height };
  try {
    return run();
  } finally {
    globalThis.window = previous;
  }
}

const { imageLightboxTargetBox } = await import("./imageLightbox.ts");

// Sam's exact shape (report 9/14): a 1057px-tall viewer window. The old
// 0.8-ratio fit left the photo letterboxed with wide black margins.
test("a portrait photo fills 92% of the constrained (height) side", () => {
  withViewport(2560, 1057, () => {
    const box = imageLightboxTargetBox({
      height: 4032,
      width: 3024,
      left: 0,
      top: 0,
    });
    assert.ok(Math.abs(box.height - 972.44) < 0.01, `height ${box.height}`);
    assert.ok(Math.abs(box.width - 729.33) < 0.01, `width ${box.width}`);
  });
});

test("the fitted photo is centered in the viewport", () => {
  withViewport(2000, 1000, () => {
    const box = imageLightboxTargetBox({
      height: 3000,
      width: 2000,
      left: 0,
      top: 0,
    });
    assert.ok(
      Math.abs(box.left - (2000 - box.width) / 2) < 0.01,
      `left ${box.left}`,
    );
    assert.ok(
      Math.abs(box.top - (1000 - box.height) / 2) < 0.01,
      `top ${box.top}`,
    );
  });
});

test("a viewport that grew after open produces a larger refit (stale-box heal input)", () => {
  // Opened at 674px tall, window later maximized to 1057: re-running the fit
  // must track the live viewport, not the open-time one.
  const atOpen = withViewport(2560, 674, () =>
    imageLightboxTargetBox({ height: 4032, width: 3024, left: 0, top: 0 }),
  );
  const afterGrow = withViewport(2560, 1057, () =>
    imageLightboxTargetBox({ height: 4032, width: 3024, left: 0, top: 0 }),
  );
  assert.ok(
    Math.abs(atOpen.height - 620.08) < 0.01,
    `open-time height ${atOpen.height}`,
  );
  assert.ok(
    Math.abs(afterGrow.height - 972.44) < 0.01,
    `refit height ${afterGrow.height}`,
  );
});

test("the viewer upscales small images to the same fit (zoom view, not inline frame)", () => {
  withViewport(2560, 1057, () => {
    const box = imageLightboxTargetBox({
      height: 200,
      width: 300,
      left: 0,
      top: 0,
    });
    assert.ok(Math.abs(box.height - 972.44) < 0.01, `height ${box.height}`);
    assert.ok(
      Math.abs(box.width / box.height - 1.5) < 1e-6,
      `aspect ${box.width / box.height}`,
    );
  });
});

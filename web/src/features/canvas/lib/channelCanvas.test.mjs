import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasFromEvent,
  channelCanvasFilter,
  channelCanvasListed,
  hasCanvasContent,
  KIND_CANVAS,
  newerCanvas,
} from "./channelCanvas.ts";

/**
 * The channel canvas as the right pane's Canvas reads it. The wire shape is
 * buzz-sdk `build_set_canvas` (kind 40100, one `h` tag, markdown content);
 * the expected values below are written out by hand, not derived from the
 * module's own constants.
 */

const CHANNEL = "c3309d9d-3ee5-52c1-8309-e6738b177a19";
const OTHER = "608b186a-79c3-4319-9f14-1a92704df653";

function event(overrides = {}) {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_790_000_000,
    kind: 40100,
    tags: [["h", CHANNEL]],
    content: "# Team Directory\n\nSend work directly to a team.",
    ...overrides,
  };
}

test("the canvas REQ is kind 40100, scoped by #h (live), newest one", () => {
  assert.equal(KIND_CANVAS, 40100);
  assert.deepEqual(channelCanvasFilter(CHANNEL), {
    kinds: [40100],
    "#h": [CHANNEL],
    limit: 1,
  });
});

test("an event for this channel parses to its document", () => {
  assert.deepEqual(canvasFromEvent(event(), CHANNEL), {
    eventId: "a".repeat(64),
    channelId: CHANNEL,
    content: "# Team Directory\n\nSend work directly to a team.",
    authorPubkey: "b".repeat(64),
    updatedAt: 1_790_000_000,
  });
});

test("another channel's canvas, or another kind, is not this canvas", () => {
  assert.equal(canvasFromEvent(event({ tags: [["h", OTHER]] }), CHANNEL), null);
  assert.equal(canvasFromEvent(event({ tags: [] }), CHANNEL), null);
  assert.equal(canvasFromEvent(event({ kind: 9 }), CHANNEL), null);
  // An `e` or `d` tag naming the channel is not the channel scope.
  assert.equal(
    canvasFromEvent(event({ tags: [["d", CHANNEL]] }), CHANNEL),
    null,
  );
});

test("the newest set wins; a same-second tie goes to the larger id", () => {
  const old = canvasFromEvent(event({ created_at: 100 }), CHANNEL);
  const fresh = canvasFromEvent(
    event({ id: "c".repeat(64), created_at: 200, content: "v2" }),
    CHANNEL,
  );
  assert.equal(newerCanvas(old, fresh)?.content, "v2");
  assert.equal(newerCanvas(fresh, old)?.content, "v2", "order of arrival");
  assert.equal(newerCanvas(null, old), old);
  assert.equal(newerCanvas(old, null), old);
  const tieLow = canvasFromEvent(
    event({ id: "1".repeat(64), created_at: 5, content: "low" }),
    CHANNEL,
  );
  const tieHigh = canvasFromEvent(
    event({ id: "f".repeat(64), created_at: 5, content: "high" }),
    CHANNEL,
  );
  assert.equal(newerCanvas(tieLow, tieHigh)?.content, "high");
  assert.equal(newerCanvas(tieHigh, tieLow)?.content, "high");
});

test("a cleared (blank) canvas is no document", () => {
  assert.equal(hasCanvasContent(null), false);
  assert.equal(
    hasCanvasContent(canvasFromEvent(event({ content: " \n\t" }), CHANNEL)),
    false,
  );
  assert.equal(hasCanvasContent(canvasFromEvent(event(), CHANNEL)), true);
});

test("Canvas lists the channel canvas when it has content, or while it loads under the viewer", () => {
  const doc = canvasFromEvent(event(), CHANNEL);
  const blank = canvasFromEvent(event({ content: "" }), CHANNEL);
  // Phase × doc × the viewer's selection, written out.
  const cases = [
    ["ready", doc, null, true],
    ["ready", doc, "f1", true],
    ["ready", blank, "canvas:channel", false],
    ["ready", null, "canvas:channel", false],
    ["loading", null, "canvas:channel", true],
    ["loading", null, "f1", false],
    ["loading", null, null, false],
    ["loading", doc, "f1", true],
    ["idle", null, "canvas:channel", false],
  ];
  for (const [phase, given, selected, expected] of cases) {
    assert.equal(
      channelCanvasListed(phase, given, selected),
      expected,
      `${phase} ${given ? "doc" : "none"} ${selected}`,
    );
  }
});

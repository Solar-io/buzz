import assert from "node:assert/strict";
import { test } from "node:test";
import { decideGeometryDiagnostic } from "./geometryDiagnostic.ts";

const HEALTHY_VIEW = {
  timelineMounted: true,
  timelineRows: 12,
  composerPresent: true,
  timelineHeight: 604,
  wrapperHeight: 604,
};

test("healthy conversation never fires", () => {
  const d = decideGeometryDiagnostic(HEALTHY_VIEW);
  assert.equal(d.fire, false);
  assert.equal(d.reason, "healthy");
});

test("the device signature fires: content rows with NO composer (composer-less tell)", () => {
  const d = decideGeometryDiagnostic({ ...HEALTHY_VIEW, composerPresent: false, timelineRows: 1, timelineHeight: 200 });
  assert.deepEqual(d, { fire: true, trigger: "composer-less" });
});

test("collapsed list with composer fires the collapsed trigger (guard's condition)", () => {
  const d = decideGeometryDiagnostic({ ...HEALTHY_VIEW, timelineHeight: 0, wrapperHeight: 592 });
  assert.deepEqual(d, { fire: true, trigger: "collapsed-list" });
});

test("healthy composer-less states excluded BY NAME (Dwight condition 1)", () => {
  // Login gate, picker, settings, files, loading — no timeline mounted.
  const noConv = decideGeometryDiagnostic({ ...HEALTHY_VIEW, timelineMounted: false, composerPresent: false });
  assert.equal(noConv.fire, false);
  assert.match(noConv.reason, /login-picker-settings-files/);
  // Empty conversation WITH composer is healthy.
  const empty = decideGeometryDiagnostic({ ...HEALTHY_VIEW, timelineRows: 0, timelineHeight: 604 });
  assert.equal(empty.fire, false);
  assert.match(empty.reason, /empty-conversation-with-composer/);
});

test("small wrapper never fires the collapsed trigger (tiny-pane guard)", () => {
  const d = decideGeometryDiagnostic({ ...HEALTHY_VIEW, timelineHeight: 0, wrapperHeight: 120 });
  assert.equal(d.fire, false);
});

test("unmeasurable timeline (-1) does not fire", () => {
  const d = decideGeometryDiagnostic({ ...HEALTHY_VIEW, timelineHeight: -1 });
  assert.equal(d.fire, false);
});

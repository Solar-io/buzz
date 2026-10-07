import assert from "node:assert/strict";
import { test } from "node:test";

const { COMMIT_CONTROL, CommitWindow, isPttRelease, PTT_COMMIT_WINDOW_MS } =
  await import("./pttCommit.ts");

test("wire and window constants are hardcoded", () => {
  assert.equal(COMMIT_CONTROL, '{"type":"commit"}');
  assert.deepEqual(JSON.parse(COMMIT_CONTROL), { type: "commit" });
  assert.equal(PTT_COMMIT_WINDOW_MS, 2_500);
});

test("only a live→dark edge in push-to-talk mode is a release", () => {
  assert.equal(isPttRelease(true, false, true), true);
  assert.equal(isPttRelease(true, false, false), false, "open mic mute");
  assert.equal(isPttRelease(false, false, true), false);
  assert.equal(isPttRelease(true, true, true), false);
  assert.equal(isPttRelease(false, true, true), false);
});

test("the next final after a commit publishes now — once, inside the window", () => {
  const w = new CommitWindow();
  assert.equal(w.takeImmediate(0), false, "no commit, no shortcut");
  w.open(1_000);
  assert.equal(w.takeImmediate(1_200), true);
  assert.equal(w.takeImmediate(1_300), false, "one final per commit");
  w.open(5_000);
  assert.equal(w.takeImmediate(7_501), false, "past the window");
  assert.equal(w.takeImmediate(7_400), false, "an expired window is spent");
  w.open(9_000);
  assert.equal(w.takeImmediate(11_500), true, "the window edge is inclusive");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideTimelineRecovery,
  WRAPPER_MIN_HEIGHT,
  LIST_COLLAPSED_MAX,
  COLLAPSED_BEATS_REQUIRED,
  MAX_RECOVERIES,
} from "./timelineRecovery.ts";

const W = 592; // healthy wrapper height from the 9/15 trace

test("deliberately-lost race (Dwight's gate): sustained collapse fires the guard", () => {
  // The exact lost race: wrapper laid out, size notification dropped,
  // list pinned at 0 across consecutive samples. First sample waits
  // (one-beat debounce), second fires.
  const first = decideTimelineRecovery({
    wrapperHeight: W,
    listHeight: 0,
    collapsedBeats: 0,
    recoveries: 0,
  });
  assert.equal(first.action, "wait");
  assert.equal(first.collapsedBeats, 1);
  const second = decideTimelineRecovery({
    wrapperHeight: W,
    listHeight: 0,
    collapsedBeats: 1,
    recoveries: 0,
  });
  assert.equal(second.action, "recover");
});

test("single transient zero does not remount (mount flicker tolerance)", () => {
  const first = decideTimelineRecovery({
    wrapperHeight: W,
    listHeight: 0,
    collapsedBeats: 0,
    recoveries: 0,
  });
  assert.equal(first.action, "wait");
  const next = decideTimelineRecovery({
    wrapperHeight: W,
    listHeight: 500,
    collapsedBeats: 1,
    recoveries: 0,
  });
  assert.equal(next.action, "healthy");
  assert.equal(next.collapsedBeats, 0);
});

test("healthy list never fires regardless of run length (CO's constraint)", () => {
  let beats = 0;
  for (let i = 0; i < 50; i++) {
    const d = decideTimelineRecovery({
      wrapperHeight: W,
      listHeight: 583,
      collapsedBeats: beats,
      recoveries: 0,
    });
    assert.equal(d.action, "healthy");
    beats = d.collapsedBeats;
  }
  assert.equal(beats, 0);
});

test("small wrappers are ignored — no false recovery in tiny panes", () => {
  for (const wh of [0, 40, LIST_COLLAPSED_MAX, WRAPPER_MIN_HEIGHT - 1]) {
    const d = decideTimelineRecovery({
      wrapperHeight: wh,
      listHeight: 0,
      collapsedBeats: 5,
      recoveries: 0,
    });
    assert.equal(d.action, "healthy", `wrapper ${wh}`);
  }
});

test("exactly COLLAPSED_BEATS_REQUIRED sustained samples fire — off-by-one guard", () => {
  let beats = 0;
  let action = "healthy";
  for (let i = 0; i < COLLAPSED_BEATS_REQUIRED; i++) {
    const d = decideTimelineRecovery({
      wrapperHeight: W,
      listHeight: 0,
      collapsedBeats: beats,
      recoveries: 0,
    });
    action = d.action;
    beats = d.collapsedBeats;
  }
  assert.equal(action, "recover");
});

test("MAX_RECOVERIES exhausted: the guard stands down instead of looping", () => {
  for (let r = 0; r < MAX_RECOVERIES; r++) {
    const d = decideTimelineRecovery({
      wrapperHeight: W,
      listHeight: 0,
      collapsedBeats: COLLAPSED_BEATS_REQUIRED - 1,
      recoveries: r,
    });
    assert.equal(d.action, "recover", `recovery ${r + 1}`);
  }
  const past = decideTimelineRecovery({
    wrapperHeight: W,
    listHeight: 0,
    collapsedBeats: COLLAPSED_BEATS_REQUIRED - 1,
    recoveries: MAX_RECOVERIES,
  });
  assert.equal(past.action, "wait");
});

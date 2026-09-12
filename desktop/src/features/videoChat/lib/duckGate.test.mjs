import assert from "node:assert/strict";
import test from "node:test";

import {
  computeRms,
  createDuckGate,
  DEFAULT_DUCK_GATE_CONFIG,
  stepDuckGate,
} from "./duckGate.ts";

// Every expected value below is a literal worked out by hand from the
// config in play — never derived from the constants under test.

const DEFAULTS = DEFAULT_DUCK_GATE_CONFIG;

function listen() {
  return createDuckGate();
}

test("default config is the shipped tuning", () => {
  assert.deepEqual(DEFAULTS, {
    attackMs: 300,
    holdMs: 1500,
    offThreshold: 0.012,
    onThreshold: 0.02,
  });
});

test("silence never transitions the gate", () => {
  let state = listen();
  for (const now of [0, 1_000, 60_000, 3_600_000]) {
    const step = stepDuckGate(state, 0.001, now, DEFAULTS);
    assert.equal(step.ducked, false, `now=${now}`);
    assert.equal(step.changed, false, `now=${now}`);
    assert.equal(step.state.phase, "listening", `now=${now}`);
    state = step.state;
  }
});

test("attack: gate closes only after the level holds above onThreshold", () => {
  let state = listen();
  // Loud onset starts the attack clock at the first loud sample.
  state = stepDuckGate(state, 0.05, 1_000, DEFAULTS).state;
  // 299ms in: still below the 300ms attack window.
  let step = stepDuckGate(state, 0.05, 1_299, DEFAULTS);
  assert.equal(step.ducked, false);
  assert.equal(step.changed, false);
  state = step.state;
  // 300ms in: the gate closes.
  step = stepDuckGate(state, 0.05, 1_300, DEFAULTS);
  assert.equal(step.ducked, true);
  assert.equal(step.changed, true);
  assert.equal(step.state.phase, "ducked");
});

test("attack: a blip below onThreshold resets the window", () => {
  let state = listen();
  state = stepDuckGate(state, 0.05, 1_000, DEFAULTS).state;
  state = stepDuckGate(state, 0.05, 1_200, DEFAULTS).state;
  // A quiet knock abandons the partial attack.
  state = stepDuckGate(state, 0.005, 1_201, DEFAULTS).state;
  state = stepDuckGate(state, 0.05, 1_250, DEFAULTS).state;
  // 300ms after the RESET (1_250), not after the original onset (1_000).
  const step = stepDuckGate(state, 0.05, 1_549, DEFAULTS);
  assert.equal(step.ducked, false, "must still be attacking");
  const closed = stepDuckGate(step.state, 0.05, 1_550, DEFAULTS);
  assert.equal(closed.ducked, true);
  assert.equal(closed.changed, true);
});

test("hysteresis: closing needs onThreshold, the band between thresholds changes nothing", () => {
  let state = listen();
  // Just under on: never even starts an attack, however long it holds.
  state = stepDuckGate(state, 0.019, 500, DEFAULTS).state;
  const stillOpen = stepDuckGate(state, 0.019, 100_000, DEFAULTS);
  assert.equal(stillOpen.ducked, false);
  assert.equal(stillOpen.changed, false);
  state = stillOpen.state;
  // Exactly on starts the attack.
  state = stepDuckGate(state, 0.02, 100_100, DEFAULTS).state;
  const preClose = stepDuckGate(state, 0.02, 100_399, DEFAULTS);
  assert.equal(preClose.ducked, false, "299ms into a 300ms attack");
  state = preClose.state;
  // 300ms past onset: the gate closes.
  const ducked = stepDuckGate(state, 0.05, 100_400, DEFAULTS);
  assert.equal(ducked.ducked, true);
  assert.equal(ducked.changed, true);
  state = ducked.state;
  // Ducking: a sample in the dead band (off <= rms < on) neither reopens
  // nor counts as silence — it refreshes the hold clock to 100_500.
  const band = stepDuckGate(state, 0.015, 100_500, DEFAULTS);
  assert.equal(band.ducked, true);
  assert.equal(band.changed, false);
  state = band.state;
  // 1_499ms after the band refresh: still held. (Without the refresh the
  // clock would read 1_599ms past the close and the gate would reopen.)
  const held = stepDuckGate(state, 0.001, 101_999, DEFAULTS);
  assert.equal(held.ducked, true, "band sample refreshed the hold");
  assert.equal(held.changed, false);
  const reopened = stepDuckGate(held.state, 0.001, 102_000, DEFAULTS);
  assert.equal(reopened.ducked, false);
  assert.equal(reopened.changed, true);
});

test("hold tail: reopen waits holdMs below offThreshold", () => {
  let state = listen();
  state = stepDuckGate(state, 0.05, 1_000, DEFAULTS).state;
  state = stepDuckGate(state, 0.05, 1_300, DEFAULTS).state; // ducked, lastLoud=1_300
  state = stepDuckGate(state, 0.05, 1_350, DEFAULTS).state; // lastLoud=1_350
  // True silence from here: reopen is due at 1_350 + 1_500 = 2_850.
  const before = stepDuckGate(state, 0.001, 2_849, DEFAULTS);
  assert.equal(before.ducked, true);
  assert.equal(before.changed, false);
  const at = stepDuckGate(before.state, 0.001, 2_850, DEFAULTS);
  assert.equal(at.ducked, false);
  assert.equal(at.changed, true);
  assert.equal(at.state.phase, "listening");
  // Reopened gate goes quiet-clean: a further silent sample changes nothing.
  const after = stepDuckGate(at.state, 0.001, 5_000, DEFAULTS);
  assert.equal(after.changed, false);
  assert.equal(after.ducked, false);
});

test("hold tail: a loud sample during the tail extends it", () => {
  let state = listen();
  state = stepDuckGate(state, 0.05, 1_000, DEFAULTS).state;
  state = stepDuckGate(state, 0.05, 1_300, DEFAULTS).state; // ducked, lastLoud=1_300
  state = stepDuckGate(state, 0.05, 2_000, DEFAULTS).state; // she says more
  // Silence from 2_000: without the extension the gate would reopen at 2_800.
  const wouldHaveReopened = stepDuckGate(state, 0.001, 2_800, DEFAULTS);
  assert.equal(wouldHaveReopened.ducked, true);
  assert.equal(wouldHaveReopened.changed, false);
  const reopened = stepDuckGate(
    wouldHaveReopened.state,
    0.001,
    3_500,
    DEFAULTS,
  );
  assert.equal(reopened.ducked, false);
  assert.equal(reopened.changed, true);
});

test("a full utterance round-trips: listening -> ducked -> listening", () => {
  let state = listen();
  const samples = [
    [0.001, 0], // quiet
    [0.04, 50], // speech starts
    [0.04, 100],
    [0.04, 150],
    [0.04, 200],
    [0.04, 250],
    [0.04, 300], // 250ms past onset — not yet
    [0.04, 350], // 300ms — duck
    [0.011, 400], // trailing off (below off)
    [0.001, 1_800], // hold tail running (lastLoud=350 → due 1_850)
    [0.001, 1_850], // reopen
    [0.001, 2_000], // quiet, no change
  ];
  const transitions = [];
  for (const [rms, now] of samples) {
    const step = stepDuckGate(state, rms, now, DEFAULTS);
    if (step.changed) transitions.push([step.ducked, now]);
    state = step.state;
  }
  assert.deepEqual(transitions, [
    [true, 350],
    [false, 1_850],
  ]);
});

test("computeRms returns exact values for constant and mixed frames", () => {
  assert.equal(computeRms([]), 0);
  assert.equal(computeRms([0.5, 0.5, 0.5, 0.5]), 0.5);
  assert.equal(computeRms([-1, 1]), 1);
  assert.equal(computeRms([3, -3, 3, -3]), 3);
  assert.equal(computeRms([0, 2]), Math.sqrt(2));
  assert.equal(computeRms(new Float32Array([0.25, 0.25])), 0.25);
});

import assert from "node:assert/strict";
import { test } from "node:test";

const { FloorGate, FLOOR_CAP_MS, FLOOR_QUIET_MS, waitForFloor } = await import(
  "./floorGate.ts"
);

/** A fake clock whose sleep advances time and replays scripted mic samples. */
function fakeClock(gate, samples = []) {
  let t = 0;
  const pending = [...samples].sort((a, b) => a.at - b.at);
  const apply = () => {
    while (pending.length > 0 && pending[0].at <= t) {
      const s = pending.shift();
      gate.noteMic(s.speaking, s.at);
    }
  };
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      apply();
    },
    set: (v) => {
      t = v;
      apply();
    },
  };
}

test("constants are the specified values", () => {
  assert.equal(FLOOR_QUIET_MS, 300);
  assert.equal(FLOOR_CAP_MS, 2_500);
});

test("a free floor starts the reply at once", async () => {
  const gate = new FloorGate();
  const clock = fakeClock(gate);
  assert.equal(gate.waitMs(0, 0), 0);
  assert.equal(await waitForFloor(gate, clock), 0);
});

test("while he talks the reply waits for 300 ms of quiet", async () => {
  const gate = new FloorGate();
  const clock = fakeClock(gate, [
    { at: 0, speaking: true },
    { at: 400, speaking: true },
    { at: 700, speaking: false },
  ]);
  clock.set(0);
  // Due at 0, he stops at 700 → the reply starts at 1000.
  const waited = await waitForFloor(gate, clock);
  assert.equal(waited, 1_000);
});

test("a recent end of speech still owes the rest of the quiet window", () => {
  const gate = new FloorGate();
  gate.noteMic(true, 0);
  gate.noteMic(false, 100);
  assert.equal(gate.waitMs(250, 250), 150);
  assert.equal(gate.waitMs(400, 250), 0);
});

test("the wait is capped at 2.5 s even if he never stops", async () => {
  const gate = new FloorGate();
  gate.noteMic(true, 0);
  const clock = fakeClock(gate);
  const waited = await waitForFloor(gate, clock);
  assert.equal(waited, 2_500);
});

test("cap counts from when the reply became due, not from his speech", () => {
  const gate = new FloorGate();
  gate.noteMic(true, 0);
  assert.equal(gate.waitMs(5_500, 3_000), 0);
  assert.equal(gate.waitMs(5_000, 3_000), 300);
  assert.equal(gate.waitMs(5_000, 4_000), 300);
  assert.equal(gate.waitMs(6_400, 4_000), 100);
});

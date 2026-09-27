import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStagePacer,
  readingTimeMs,
  STAGE_GAP_MS,
} from "./stagePacing.ts";

/** Deterministic clock: timers fire only when `advance` passes them. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await flush();
        let dueId = null;
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!due || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (!due) break;
        timers.delete(dueId);
        now = due.at;
        due.fn();
      }
      now = target;
      await flush();
    },
  };
}

async function flush() {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
}

/** speak() returns a deferred the test settles by hand. */
function harness(options = {}) {
  const clock = fakeClock();
  const calls = [];
  const deferreds = new Map();
  let interrupts = 0;
  const shown = [];
  const pacer = createStagePacer({
    clock,
    voice: true,
    ...options,
    speak: (showing) => {
      calls.push(showing.eventId);
      if (options.speakNever) return new Promise(() => {});
      return new Promise((resolve) => deferreds.set(showing.eventId, resolve));
    },
    interrupt: () => {
      interrupts += 1;
    },
    onChange: (state) => {
      const id = state.current?.eventId ?? null;
      if (id && shown[shown.length - 1]?.id !== id) {
        shown.push({ id, at: clock.now() });
      }
    },
  });
  return {
    clock,
    pacer,
    calls,
    shown,
    finishSpeaking: async (id) => {
      deferreds.get(id)?.();
      await flush();
    },
    interrupts: () => interrupts,
    current: () => pacer.state().current?.eventId ?? null,
  };
}

const showing = (id, extra = {}) => ({
  eventId: id,
  hold: true,
  speakText: `Words for ${id}.`,
  createdAt: Number(id.replace(/\D/g, "")) || 0,
  ...extra,
});

test("P1: held part 2 waits for speak(1) to resolve, then shows at +gap", async () => {
  const h = harness();
  h.pacer.arrive(showing("p1"));
  h.pacer.arrive(showing("p2"));
  await flush();
  assert.equal(h.current(), "p1");
  assert.deepEqual(h.calls, ["p1"]);
  await h.clock.advance(5_000);
  assert.equal(h.current(), "p1", "p2 must not show while speak(p1) pends");
  await h.finishSpeaking("p1");
  await h.clock.advance(STAGE_GAP_MS - 1);
  assert.equal(h.current(), "p1", "p2 must not show before the gap");
  await h.clock.advance(1);
  assert.equal(h.current(), "p2");
  assert.equal(h.shown[1].at, 5_000 + STAGE_GAP_MS);
  assert.deepEqual(h.calls, ["p1", "p2"]);
});

test("P2: voice:false shows every part on arrival, no speak, no gap", async () => {
  const h = harness({ voice: false });
  h.pacer.arrive(showing("p1"));
  assert.equal(h.current(), "p1");
  h.pacer.arrive(showing("p2"));
  assert.equal(h.current(), "p2");
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.pacer.state().releasedCount, 2);
});

test("P3: muted releases at readingTimeMs with ZERO speak calls", async () => {
  const h = harness({ muted: true });
  const text = "x".repeat(100); // 6 s of reading
  h.pacer.arrive(showing("p1", { speakText: text }));
  h.pacer.arrive(showing("p2"));
  await h.clock.advance(readingTimeMs(text) + STAGE_GAP_MS - 1);
  assert.equal(h.current(), "p1");
  await h.clock.advance(1);
  assert.equal(h.current(), "p2");
  assert.equal(h.calls.length, 0, "speak must never be called while muted");
});

test("P4: a speak that never resolves releases at watchdogMs", async () => {
  const h = harness({ speakNever: true, watchdogMs: () => 7_000 });
  h.pacer.arrive(showing("p1"));
  h.pacer.arrive(showing("p2"));
  await h.clock.advance(7_000 + STAGE_GAP_MS - 1);
  assert.equal(h.current(), "p1");
  await h.clock.advance(1);
  assert.equal(h.current(), "p2");
  assert.equal(h.interrupts(), 1, "the watchdog stops the hung utterance");
});

test("hold:false shows on arrival while a prior speak pends; interrupts once", async () => {
  const h = harness();
  h.pacer.arrive(showing("p1"));
  await flush();
  assert.deepEqual(h.calls, ["p1"]);
  h.pacer.arrive(showing("p2", { hold: false }));
  await flush();
  assert.equal(h.current(), "p2", "unheld showing must not wait for speech");
  assert.equal(h.interrupts(), 1);
  assert.deepEqual(h.calls, ["p1", "p2"], "it speaks its own text");
});

test("hold:false silently releases earlier queued held showings", async () => {
  const h = harness();
  h.pacer.arrive(showing("p1"));
  h.pacer.arrive(showing("p2"));
  h.pacer.arrive(showing("p3"));
  await flush();
  assert.equal(h.pacer.state().queued, 2);
  h.pacer.arrive(showing("p4", { hold: false }));
  await flush();
  const state = h.pacer.state();
  assert.equal(h.current(), "p4");
  assert.equal(state.releasedCount, 4);
  assert.ok(state.releasedIds.has("p2") && state.releasedIds.has("p3"));
  assert.deepEqual(h.calls, ["p1", "p4"], "p2/p3 are never spoken");
  assert.deepEqual(
    h.shown.map((s) => s.id),
    ["p1", "p4"],
    "p2/p3 are never staged",
  );
});

test("manual next() releases immediately and calls interrupt once", async () => {
  const h = harness();
  h.pacer.arrive(showing("p1"));
  h.pacer.arrive(showing("p2"));
  await flush();
  h.pacer.next();
  await flush();
  assert.equal(h.current(), "p2");
  assert.equal(h.interrupts(), 1);
  assert.deepEqual(h.calls, ["p1", "p2"]);
});

test("replay of 3 showings speaks exactly 3 times, in order", async () => {
  const h = harness();
  h.pacer.seed([showing("p1"), showing("p2"), showing("p3")], "replay");
  for (const id of ["p1", "p2", "p3"]) {
    await flush();
    await h.finishSpeaking(id);
    await h.clock.advance(STAGE_GAP_MS);
  }
  assert.deepEqual(h.calls, ["p1", "p2", "p3"]);
});

test("replay speaks a repeated frame both times (two showings, same i)", async () => {
  const h = harness();
  const a = showing("p1", { i: 4 });
  const b = showing("p2", { i: 4 });
  h.pacer.seed([a, b], "replay");
  await flush();
  await h.finishSpeaking("p1");
  await h.clock.advance(STAGE_GAP_MS);
  assert.equal(h.calls.length, 2);
});

test("replay treats hold:false history as held (walks every showing)", async () => {
  const h = harness();
  h.pacer.seed([showing("p1"), showing("p2", { hold: false })], "replay");
  await flush();
  assert.equal(h.current(), "p1");
  assert.equal(h.pacer.state().releasedCount, 1);
});

test("unmuting mid-part does not re-speak the current part", async () => {
  const h = harness({ muted: true });
  h.pacer.arrive(showing("p1"));
  await h.clock.advance(1_000);
  h.pacer.setMuted(false);
  await h.clock.advance(1_000);
  assert.equal(h.calls.length, 0);
  h.pacer.arrive(showing("p2"));
  await h.clock.advance(readingTimeMs("Words for p1.") + STAGE_GAP_MS);
  assert.equal(h.current(), "p2");
  assert.deepEqual(h.calls, ["p2"], "the next part speaks after unmute");
});

test("muting mid-part interrupts and finishes on the reading remainder", async () => {
  const h = harness();
  const text = "y".repeat(100);
  h.pacer.arrive(showing("p1", { speakText: text }));
  h.pacer.arrive(showing("p2"));
  await h.clock.advance(2_000);
  h.pacer.setMuted(true);
  assert.equal(h.interrupts(), 1);
  // Resolving the stale speak must not release early.
  await h.finishSpeaking("p1");
  await h.clock.advance(readingTimeMs(text) - 2_000 + STAGE_GAP_MS - 1);
  assert.equal(h.current(), "p1");
  await h.clock.advance(1);
  assert.equal(h.current(), "p2");
  assert.deepEqual(h.calls, ["p1"]);
});

test("audio unavailable paces like muted (no speak)", async () => {
  const h = harness({ audioAvailable: false });
  h.pacer.arrive(showing("p1"));
  await flush();
  assert.equal(h.calls.length, 0);
});

test("speak-once across a duplicate arrive", async () => {
  const h = harness();
  h.pacer.arrive(showing("p1"));
  h.pacer.arrive(showing("p1"));
  await flush();
  assert.deepEqual(h.calls, ["p1"]);
  assert.equal(h.pacer.state().showings.length, 1);
});

test("prev browses back without speaking; releases pause; live resumes", async () => {
  const h = harness({ voice: false });
  h.pacer.arrive(showing("p1"));
  h.pacer.arrive(showing("p2"));
  h.pacer.prev();
  assert.equal(h.current(), "p1");
  assert.equal(h.pacer.state().browsing, true);
  h.pacer.arrive(showing("p3"));
  assert.equal(h.current(), "p1", "browsing holds the view");
  h.pacer.live();
  assert.equal(h.current(), "p3");
  assert.equal(h.calls.length, 0);
});

test("late join starts at the newest showing without speaking backlog", async () => {
  const h = harness();
  h.pacer.seed([showing("p1"), showing("p2"), showing("p3")], "late");
  await flush();
  assert.equal(h.current(), "p3");
  assert.equal(h.calls.length, 0);
  h.pacer.restart();
  await flush();
  assert.equal(h.current(), "p1");
  assert.deepEqual(h.calls, ["p1"]);
});

test("image gate: release waits for imageReady, capped at 3 s", async () => {
  const h = harness({
    voice: false,
    imageReady: () => new Promise(() => {}),
  });
  h.pacer.arrive(showing("p1"));
  await h.clock.advance(2_999);
  assert.equal(h.current(), null);
  await h.clock.advance(1);
  assert.equal(h.current(), "p1");
});

test("bug1: a live same-second showing with a smaller id is queued, never silently released", async () => {
  const h = harness();
  // Same created_at; the later post has the SMALLER id, so its sort key
  // puts it before what is on stage.
  h.pacer.arrive(showing("z", { createdAt: 5 }));
  await flush();
  assert.equal(h.current(), "z");
  h.pacer.arrive(showing("a", { createdAt: 5 }));
  await flush();
  assert.equal(h.pacer.state().queued, 1, "the live arrival waits its turn");
  await h.finishSpeaking("z");
  await h.clock.advance(STAGE_GAP_MS);
  assert.equal(h.current(), "a", "and is staged after the current one");
  assert.deepEqual(h.calls, ["z", "a"], "and spoken");
});

test("bug1: a live unheld showing that sorts before current still stages", async () => {
  const h = harness();
  h.pacer.arrive(showing("z", { createdAt: 5 }));
  await flush();
  h.pacer.arrive(showing("a", { createdAt: 5, hold: false }));
  await flush();
  assert.equal(h.current(), "a");
  assert.deepEqual(h.calls, ["z", "a"]);
});

test("bug1: replay orders same-second showings by seq, then id", async () => {
  const h = harness({ voice: false });
  h.pacer.seed(
    [
      showing("a", { createdAt: 5, seq: 2 }),
      showing("z", { createdAt: 5, seq: 1 }),
      showing("m", { createdAt: 4, seq: 9 }),
    ],
    "replay",
  );
  await flush();
  assert.deepEqual(
    h.pacer.state().showings.map((s) => s.eventId),
    ["m", "z", "a"],
  );
});

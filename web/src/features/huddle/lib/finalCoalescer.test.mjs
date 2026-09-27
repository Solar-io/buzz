import assert from "node:assert/strict";
import { test } from "node:test";

const { FinalCoalescer, FinalMerger, MAX_RUN_MS, MERGE_MS } = await import(
  "./finalCoalescer.ts"
);

/** Deterministic fake clock: timers fire only when `advance` passes them. */
function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (due === null || timer.at < due[1].at)) {
            due = [id, timer];
          }
        }
        if (due === null) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    get armed() {
      return timers.size;
    },
  };
}

function merger() {
  const clock = fakeClock();
  const published = [];
  const m = new FinalMerger((text) => published.push(text), clock);
  return { clock, published, m };
}

test("constants are the specified values", () => {
  assert.equal(MERGE_MS, 600);
  assert.equal(MAX_RUN_MS, 30_000);
});

test("two finals 1s apart with a partial between publish as ONE message", () => {
  const { clock, published, m } = merger();
  m.final("so I was thinking");
  clock.advance(500);
  m.partial(); // still talking
  clock.advance(500);
  m.final("we could ship it Friday");
  assert.deepEqual(published, [], "nothing publishes while he keeps talking");
  clock.advance(599);
  assert.deepEqual(published, [], "not before 600ms of quiet");
  clock.advance(1);
  assert.deepEqual(published, ["so I was thinking we could ship it Friday"]);
  clock.advance(10_000);
  assert.equal(published.length, 1, "published exactly once");
});

test("a single final publishes after MERGE_MS of quiet", () => {
  const { clock, published, m } = merger();
  m.final("hello there");
  clock.advance(599);
  assert.deepEqual(published, []);
  clock.advance(1);
  assert.deepEqual(published, ["hello there"]);
});

test("a partial cancels the pending flush and restarts the window", () => {
  const { clock, published, m } = merger();
  m.final("one");
  clock.advance(550);
  m.partial();
  clock.advance(550);
  assert.deepEqual(published, [], "the partial pushed the flush out");
  clock.advance(50);
  assert.deepEqual(published, ["one"]);
});

test("stop flushes the buffer immediately and leaves no timer armed", () => {
  const { clock, published, m } = merger();
  m.final("last words");
  m.final("before stop");
  m.flush();
  assert.deepEqual(published, ["last words before stop"]);
  assert.equal(clock.armed, 0);
  clock.advance(5_000);
  assert.equal(published.length, 1, "no second publish from a stale timer");
});

test("flush with nothing buffered publishes nothing", () => {
  const { published, m } = merger();
  m.flush();
  m.partial();
  m.flush();
  assert.deepEqual(published, []);
});

test("a run past the 30s cap flushes even while he keeps talking", () => {
  const { clock, published, m } = merger();
  m.final("start");
  for (let i = 0; i < 59; i++) {
    clock.advance(500);
    m.partial(); // continuous speech, never 600ms of quiet
  }
  assert.deepEqual(published, [], "29.5s in: still buffered");
  clock.advance(500);
  m.final("thirty seconds in");
  assert.deepEqual(published, ["start thirty seconds in"]);
  assert.equal(clock.armed, 0, "cap flush leaves nothing pending");
  m.final("next run");
  clock.advance(600);
  assert.deepEqual(published, ["start thirty seconds in", "next run"]);
});

test("a partial alone can trip the cap", () => {
  const { clock, published, m } = merger();
  m.final("long");
  for (let i = 0; i < 60; i++) {
    clock.advance(500);
    m.partial();
  }
  assert.deepEqual(published, ["long"]);
});

test("empty and whitespace-only finals are ignored", () => {
  const { clock, published, m } = merger();
  m.final("");
  m.final("   \n\t");
  assert.equal(clock.armed, 0, "empty input arms no timer");
  clock.advance(1_000);
  m.flush();
  assert.deepEqual(published, []);
  m.final("  real text  ");
  m.final(" ");
  clock.advance(600);
  assert.deepEqual(published, ["real text"], "trimmed, blanks not joined in");
});

test("FinalCoalescer joins with a single space", () => {
  const c = new FinalCoalescer();
  assert.equal(c.push("a", 0), null);
  assert.equal(c.push("b", 10), null);
  assert.equal(c.pending, true);
  assert.equal(c.flush(), "a b");
  assert.equal(c.pending, false);
  assert.equal(c.flush(), null);
});

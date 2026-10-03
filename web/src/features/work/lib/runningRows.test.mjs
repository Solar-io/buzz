import assert from "node:assert/strict";
import { test } from "node:test";

import { jobRows, lifecycleRows } from "./runningRows.ts";
import {
  EMPTY_STATUS_STORE,
  foldStatus,
  parseTaskStatus,
} from "./taskStatus.ts";

import { jobEvent } from "./jobFixture.mjs";

const OWNED = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const CH = "0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6";
const NOW = 100_000;

let seq = 0;
function lifecycle({ author = OWNED, turn, state = "running", at, started }) {
  const tags = [
    ["d", `turn:${CH}`],
    ["h", CH],
    ["turn", turn],
    ["state", state],
    ["started", String(started ?? at)],
  ];
  if (state !== "running") {
    tags.push(["ended", String(at)]);
  }
  return parseTaskStatus({
    id: String(++seq).padStart(64, "0"),
    pubkey: author,
    kind: 30624,
    created_at: at,
    tags,
    content: "",
  });
}

function detail({ author = OWNED, turn, title, progress, at }) {
  const tags = [
    ["d", `detail:${CH}`],
    ["h", CH],
    ["turn", turn],
  ];
  if (title) {
    tags.push(["title", title]);
  }
  if (progress) {
    tags.push(["progress", String(progress[0]), String(progress[1])]);
  }
  return parseTaskStatus({
    id: String(++seq).padStart(64, "0"),
    pubkey: author,
    kind: 30624,
    created_at: at,
    tags,
    content: "",
  });
}

function store(...heads) {
  for (const head of heads) {
    assert.ok(head, "fixture head parses");
  }
  return foldStatus(EMPTY_STATUS_STORE, heads);
}

/** An observer turn as `activeTurns` reports it. */
function observed({
  agent = OWNED,
  turn,
  channelId = CH,
  startedAt,
  lastBeatAt,
  state = "live",
}) {
  return {
    agentPubkey: agent,
    turnId: turn,
    channelId,
    startedAt,
    lastBeatAt,
    state,
    triggeringEventIds: [],
  };
}

const pick = (row) => [row.key, row.source, row.state, row.title, row.progress];

test("status only: a fresh running head is a live row with its title and progress", () => {
  const { rows } = lifecycleRows(
    [],
    store(
      lifecycle({
        author: OTHER,
        turn: "t1",
        at: NOW - 30,
        started: NOW - 200,
      }),
      detail({
        author: OTHER,
        turn: "t1",
        title: "Restore drill",
        progress: [2, 3],
        at: NOW - 20,
      }),
    ),
    NOW,
  );
  assert.deepEqual(rows.map(pick), [
    [
      `turn:${OTHER}:t1`,
      "status",
      "live",
      "Restore drill",
      { done: 2, total: 3 },
    ],
  ]);
  assert.equal(rows[0].startedAt, NOW - 200, "elapsed runs from the start");
  assert.equal(rows[0].lastBeatAt, NOW - 30);
});

test("no heartbeat stays a rendered state: stalled past 180 s, lost past 600 s, gone past an hour", () => {
  const age = (seconds) =>
    lifecycleRows(
      [],
      store(lifecycle({ author: OTHER, turn: "t1", at: NOW - seconds })),
      NOW,
    ).rows.map((row) => row.state);
  assert.deepEqual(age(180), ["live"]);
  assert.deepEqual(age(181), ["stalled"]);
  assert.deepEqual(age(600), ["stalled"]);
  assert.deepEqual(age(601), ["lost"]);
  assert.deepEqual(age(3_600), ["lost"]);
  assert.deepEqual(age(3_601), []);
});

test("observer + status for the same turn is ONE row, titled from the detail", () => {
  const { rows } = lifecycleRows(
    [observed({ turn: "t1", startedAt: NOW - 100, lastBeatAt: NOW - 5 })],
    store(
      lifecycle({ turn: "t1", at: NOW - 40, started: NOW - 100 }),
      detail({
        turn: "t1",
        title: "Capture pass",
        progress: [1, 3],
        at: NOW - 30,
      }),
    ),
    NOW,
  );
  assert.deepEqual(rows.map(pick), [
    [
      `turn:${OWNED}:t1`,
      "observer",
      "live",
      "Capture pass",
      { done: 1, total: 3 },
    ],
  ]);
});

test("a fresh status refresh keeps a turn live when observer liveness is off", () => {
  // BUZZ_ACP_TURN_LIVENESS_SECS=0: the observer went quiet after 40 s, but the
  // harness's own 60 s status refresh says the turn is alive.
  const { rows } = lifecycleRows(
    [
      observed({
        turn: "t1",
        startedAt: NOW - 300,
        lastBeatAt: NOW - 240,
        state: "stalled",
      }),
    ],
    store(lifecycle({ turn: "t1", at: NOW - 50, started: NOW - 300 })),
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => [row.state, row.lastBeatAt]),
    [["live", NOW - 50]],
  );
  // Both silent: stalled, aged by the freshest of the two.
  const quiet = lifecycleRows(
    [
      observed({
        turn: "t1",
        startedAt: NOW - 900,
        lastBeatAt: NOW - 800,
        state: "lost",
      }),
    ],
    store(lifecycle({ turn: "t1", at: NOW - 400, started: NOW - 900 })),
    NOW,
  ).rows;
  assert.deepEqual(
    quiet.map((row) => row.state),
    ["stalled"],
  );
});

test("fallback: no 30624 at all keeps the observer row, with no title", () => {
  const { rows } = lifecycleRows(
    [
      observed({ turn: "t1", startedAt: NOW - 60, lastBeatAt: NOW - 3 }),
      // A heartbeat turn has no channel and so never has a status head.
      observed({
        turn: "hb",
        channelId: null,
        startedAt: NOW - 30,
        lastBeatAt: NOW - 2,
      }),
    ],
    EMPTY_STATUS_STORE,
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.source, row.title, row.progress]),
    [
      [`turn:${OWNED}:hb`, "observer", null, null],
      [`turn:${OWNED}:t1`, "observer", null, null],
    ],
  );
});

test("a title set for an EARLIER turn never shows on the observed one (D8.3)", () => {
  const { rows } = lifecycleRows(
    [observed({ turn: "t2", startedAt: NOW - 20, lastBeatAt: NOW - 2 })],
    store(
      lifecycle({ turn: "t2", at: NOW - 20, started: NOW - 20 }),
      detail({ turn: "t1", title: "Old work", at: NOW - 30 }),
    ),
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => row.title),
    [null],
  );
});

test("the harness said the observed turn ended: no Running row", () => {
  const { rows } = lifecycleRows(
    // The observer buffer lost `turn_completed`; the 30624 head did not.
    [observed({ turn: "t1", startedAt: NOW - 100, lastBeatAt: NOW - 10 })],
    store(
      lifecycle({ turn: "t1", state: "done", at: NOW - 5, started: NOW - 100 }),
    ),
    NOW,
  );
  assert.deepEqual(rows, []);
});

test("a newer status turn supersedes the observed one in the same channel", () => {
  const { rows } = lifecycleRows(
    [
      observed({
        turn: "t1",
        startedAt: NOW - 300,
        lastBeatAt: NOW - 200,
        state: "stalled",
      }),
    ],
    store(lifecycle({ turn: "t2", at: NOW - 10, started: NOW - 15 })),
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.source]),
    [[`turn:${OWNED}:t2`, "status"]],
  );
});

test("refreshes and detail updates mutate the row in place, never duplicate", () => {
  const base = [
    lifecycle({ author: OTHER, turn: "t1", at: NOW - 120, started: NOW - 120 }),
    detail({
      author: OTHER,
      turn: "t1",
      title: "Sweep",
      progress: [1, 3],
      at: NOW - 110,
    }),
  ];
  let current = store(...base);
  const before = lifecycleRows([], current, NOW).rows;
  current = foldStatus(current, [
    lifecycle({ author: OTHER, turn: "t1", at: NOW - 60, started: NOW - 120 }),
    lifecycle({ author: OTHER, turn: "t1", at: NOW, started: NOW - 120 }),
    detail({ author: OTHER, turn: "t1", progress: [2, 3], at: NOW - 1 }),
  ]);
  const after = lifecycleRows([], current, NOW).rows;
  assert.equal(after.length, 1);
  assert.equal(after[0].key, before[0].key, "same row identity");
  assert.equal(
    after[0].title,
    "Sweep",
    "the title carries across a progress-only update",
  );
  assert.deepEqual(after[0].progress, { done: 2, total: 3 });
  assert.equal(after[0].lastBeatAt, NOW);
});

test("a dismissed silent turn leaves; a terminal head is never Running", () => {
  const silent = store(lifecycle({ author: OTHER, turn: "t1", at: NOW - 900 }));
  assert.equal(lifecycleRows([], silent, NOW).rows.length, 1);
  assert.deepEqual(lifecycleRows([], silent, NOW, new Set(["t1"])).rows, []);
  const finished = store(
    lifecycle({ author: OTHER, turn: "t1", state: "cancelled", at: NOW - 5 }),
  );
  assert.deepEqual(lifecycleRows([], finished, NOW).rows, []);
});

test("spokenFor records the newest word on each (agent, channel)", () => {
  const { spokenFor } = lifecycleRows(
    [observed({ turn: "t1", startedAt: NOW - 100, lastBeatAt: NOW - 3 })],
    store(
      lifecycle({ turn: "t1", at: NOW - 40, started: NOW - 100 }),
      lifecycle({ author: OTHER, turn: "t9", state: "done", at: NOW - 70 }),
    ),
    NOW,
  );
  assert.equal(spokenFor.get(`${OWNED}|${CH}`), NOW - 3);
  assert.equal(spokenFor.get(`${OTHER}|${CH}`), NOW - 70);
});

test("job rows use the literal 300 second cutoff and never stall", () => {
  for (const [age, count] of [
    [299, 1],
    [300, 1],
    [301, 0],
  ]) {
    const rows = jobRows(
      store(parseTaskStatus(jobEvent({ at: NOW - age }))),
      NOW,
    );
    assert.equal(rows.length, count, `age ${age}`);
    if (count) {
      assert.equal(rows[0].state, "live");
      assert.equal(rows[0].source, "job");
      assert.equal(rows[0].turnId, null);
    }
  }
  assert.equal(
    jobRows(store(parseTaskStatus(jobEvent({ state: "done", at: NOW }))), NOW)
      .length,
    0,
  );
});

test("job rows keep three distinct concurrent keys and sort newest starts first", () => {
  const rows = jobRows(
    store(
      ...[1, 2, 3].map((i) =>
        parseTaskStatus(
          jobEvent({
            jobId: `j${i}`,
            at: NOW,
            started: 900 + i,
            model: "gpt-6.1-sol",
          }),
        ),
      ),
    ),
    NOW,
  );
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.key)).size, 3);
  assert.deepEqual(
    rows.map((row) => row.job.id),
    ["j3", "j2", "j1"],
  );
  assert.equal(rows[0].key, `job:${OWNED}:${CH}:j3`);
  assert.equal(rows[0].job.engine, "GPT");
  assert.equal(rows[0].progress, null);
});

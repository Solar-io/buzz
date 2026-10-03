import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_STATUS_STORE,
  engineLabel,
  jobsFinished,
  jobsRunning,
  currentTurns,
  endedTurns,
  foldStatus,
  parseTaskStatus,
  progressSegments,
  progressText,
  pruneStatus,
  statusTriggers,
} from "./taskStatus.ts";

import { jobEvent } from "./jobFixture.mjs";

const AGENT = "aa".repeat(32);
const CH = "0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6";
const CH_B = "1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d";
const TRIGGER = "cd".repeat(32);

let seq = 0;
function lifecycle(overrides = {}) {
  const state = overrides.state ?? "running";
  const channel = overrides.channel ?? CH;
  const tags = [
    ["d", `turn:${overrides.dChannel ?? channel}`],
    ["h", channel],
    ["turn", overrides.turn ?? "t1"],
    ["state", state],
    ["started", String(overrides.started ?? 1000)],
  ];
  if (state !== "running" || overrides.ended !== undefined) {
    if (overrides.ended !== null) {
      tags.push(["ended", String(overrides.ended ?? 1100)]);
    }
  }
  tags.push(...(overrides.extra ?? []));
  return {
    id: overrides.id ?? String(++seq).padStart(64, "0"),
    pubkey: overrides.author ?? AGENT,
    kind: overrides.kind ?? 30624,
    created_at: overrides.at ?? 1000,
    tags,
    content: overrides.content ?? "",
  };
}

function detail(overrides = {}) {
  const channel = overrides.channel ?? CH;
  const tags = [
    ["d", `detail:${channel}`],
    ["h", channel],
    ["turn", overrides.turn ?? "t1"],
  ];
  if (overrides.title !== undefined) {
    tags.push(["title", overrides.title]);
  }
  if (overrides.progress !== undefined) {
    tags.push(["progress", ...overrides.progress]);
  }
  tags.push(...(overrides.extra ?? []));
  return {
    id: overrides.id ?? String(++seq).padStart(64, "0"),
    pubkey: overrides.author ?? AGENT,
    kind: 30624,
    created_at: overrides.at ?? 1001,
    tags,
    content: overrides.content ?? "",
  };
}

function fold(...events) {
  return foldStatus(
    EMPTY_STATUS_STORE,
    events.map((event) => {
      const head = parseTaskStatus(event);
      assert.ok(head, `fixture parses: ${JSON.stringify(event.tags)}`);
      return head;
    }),
  );
}

// ---- parser ------------------------------------------------------------------

test("a running lifecycle head parses with its trigger", () => {
  const head = parseTaskStatus(
    lifecycle({
      extra: [
        ["e", TRIGGER, "", "trigger"],
        ["session", "0"],
      ],
    }),
  );
  assert.deepEqual(
    {
      ns: head.ns,
      state: head.state,
      channelId: head.channelId,
      turnId: head.turnId,
      started: head.started,
      ended: head.ended,
      trigger: head.trigger,
    },
    {
      ns: "turn",
      state: "running",
      channelId: CH,
      turnId: "t1",
      started: 1000,
      ended: null,
      trigger: TRIGGER,
    },
  );
});

test("a terminal head carries ended; error may carry a reason", () => {
  const head = parseTaskStatus(
    lifecycle({
      state: "error",
      ended: 1200,
      extra: [["reason", "harness-restart"]],
    }),
  );
  assert.equal(head.state, "error");
  assert.equal(head.ended, 1200);
  assert.equal(head.reason, "harness-restart");
});

test("a detail head parses title and progress", () => {
  const head = parseTaskStatus(
    detail({ title: "Fix composer draft loss", progress: ["2", "3"] }),
  );
  assert.equal(head.ns, "detail");
  assert.equal(head.title, "Fix composer draft loss");
  assert.deepEqual(head.progress, { done: 2, total: 3 });
});

test("the parser refuses what the relay refuses, never coercing", () => {
  const refused = {
    "wrong kind": lifecycle({ kind: 30623 }),
    "d channel != h": lifecycle({ dChannel: CH_B }),
    "h not a uuid": lifecycle({ channel: "general" }),
    "ended while running": lifecycle({ ended: 1100 }),
    "terminal without ended": lifecycle({ state: "done", ended: null }),
    "ended before started": lifecycle({ state: "done", ended: 999 }),
    "unknown state": lifecycle({ state: "paused", ended: 1100 }),
    "reason without error": lifecycle({
      state: "done",
      extra: [["reason", "x"]],
    }),
    "lifecycle with a title": lifecycle({ extra: [["title", "x"]] }),
    "lifecycle with content": lifecycle({ content: "hi" }),
    "trigger not hex": lifecycle({ extra: [["e", "nothex", "", "trigger"]] }),
    "two turn tags": lifecycle({ extra: [["turn", "t2"]] }),
    "bad turn id": lifecycle({ turn: "t 1" }),
    "progress done > total": detail({ progress: ["4", "3"] }),
    "progress total 0": detail({ progress: ["0", "0"] }),
    "progress total 101": detail({ progress: ["1", "101"] }),
    "progress not integers": detail({ progress: ["1.5", "3"] }),
    "progress missing total": detail({ progress: ["1"] }),
    "detail with neither": detail({}),
    "empty title": detail({ title: "" }),
    "title over 120 chars": detail({ title: "x".repeat(121) }),
    "detail with state": detail({ title: "x", extra: [["state", "done"]] }),
  };
  for (const [why, event] of Object.entries(refused)) {
    assert.equal(parseTaskStatus(event), null, why);
  }
  // The bounds themselves are allowed (pins against an off-by-one).
  assert.ok(parseTaskStatus(detail({ progress: ["100", "100"] })));
  assert.ok(parseTaskStatus(detail({ progress: ["0", "1"] })));
  assert.ok(parseTaskStatus(detail({ title: "é".repeat(120) })));
});

// ---- the store ---------------------------------------------------------------

test("the newest lifecycle head per (agent, channel) is current; older arrivals lose", () => {
  const store = fold(
    lifecycle({ at: 1060 }),
    // Out of order: an older refresh arrives after the newer one.
    lifecycle({ at: 1000 }),
  );
  const turns = currentTurns(store);
  assert.equal(turns.length, 1, "one row per (agent, channel)");
  assert.equal(turns[0].beatAt, 1060);
});

test("a tie on created_at keeps the LOWER event id (NIP-01)", () => {
  const store = fold(
    lifecycle({ id: "b".repeat(64), at: 1000, turn: "tb" }),
    lifecycle({ id: "a".repeat(64), at: 1000, turn: "ta" }),
  );
  assert.equal(currentTurns(store)[0].turnId, "ta");
});

test("a terminal head outlives its replacement for Done today", () => {
  const store = fold(
    lifecycle({ turn: "t1", state: "done", at: 1100, ended: 1100 }),
    // The next turn in the same channel replaces the addressable head...
    lifecycle({ turn: "t2", at: 1200, started: 1200 }),
  );
  assert.deepEqual(
    currentTurns(store).map((turn) => [turn.turnId, turn.state]),
    [["t2", "running"]],
  );
  // ...but the finished turn is still listed as done.
  assert.deepEqual(
    endedTurns(store, 0).map((turn) => [turn.turnId, turn.state]),
    [["t1", "done"]],
  );
  assert.deepEqual(endedTurns(store, 1101), [], "ended before the floor");
});

test("detail binds to its own turn only (D8.3)", () => {
  const store = fold(
    lifecycle({ turn: "t2", at: 1200, started: 1200 }),
    detail({ turn: "t1", title: "From the previous turn", at: 1150 }),
  );
  const [turn] = currentTurns(store);
  assert.equal(turn.turnId, "t2");
  assert.equal(turn.title, null, "a stale title never shows on a new turn");
  assert.equal(turn.progress, null);
});

test("progress-only and title-only details accumulate within one turn", () => {
  const store = fold(
    lifecycle({ turn: "t1", at: 1000 }),
    detail({ turn: "t1", title: "Capture pass", at: 1001 }),
    detail({ turn: "t1", progress: ["1", "3"], at: 1002 }),
    detail({ turn: "t1", progress: ["2", "3"], at: 1003 }),
    // A late, older progress update does not roll the bar back.
    detail({ turn: "t1", progress: ["1", "3"], at: 1002, id: "f".repeat(64) }),
  );
  const [turn] = currentTurns(store);
  assert.equal(turn.title, "Capture pass");
  assert.deepEqual(turn.progress, { done: 2, total: 3 });
});

test("folding a replay returns the same store (no render)", () => {
  const event = lifecycle({ at: 1000 });
  const store = fold(event);
  assert.equal(foldStatus(store, [parseTaskStatus(event)]), store);
});

test("triggers name the events a turn picked up", () => {
  const store = fold(
    lifecycle({ extra: [["e", TRIGGER, "", "trigger"]] }),
    lifecycle({ channel: CH_B }),
  );
  assert.deepEqual([...statusTriggers(store).get(AGENT)], [TRIGGER]);
});

test("prune drops ended turns and details older than the floor", () => {
  const store = fold(
    lifecycle({ turn: "old", state: "done", at: 100, started: 50, ended: 100 }),
    detail({ turn: "old", title: "Old", at: 100 }),
    lifecycle({ turn: "new", channel: CH_B, at: 5000, started: 5000 }),
    detail({ turn: "new", channel: CH_B, title: "New", at: 5001 }),
  );
  const pruned = pruneStatus(store, 1000);
  assert.equal(pruned.ended.size, 0);
  assert.equal(pruned.details.size, 1);
  assert.equal(pruneStatus(pruned, 1000), pruned, "nothing more to drop");
});

// ---- progress segments -------------------------------------------------------

test("segments: finished steps, the step in hand, the rest", () => {
  assert.deepEqual(progressSegments({ done: 1, total: 3 }), [
    "done",
    "current",
    "todo",
  ]);
  assert.deepEqual(progressSegments({ done: 2, total: 3 }), [
    "done",
    "done",
    "current",
  ]);
  assert.deepEqual(progressSegments({ done: 3, total: 3 }), [
    "done",
    "done",
    "done",
  ]);
  assert.deepEqual(progressSegments({ done: 0, total: 2 }), [
    "current",
    "todo",
  ]);
  assert.equal(progressSegments({ done: 5, total: 5 }).length, 5);
});

test("past five steps the row writes 'n of m' instead", () => {
  assert.equal(progressSegments({ done: 4, total: 7 }), null);
  assert.equal(progressText({ done: 4, total: 7 }), "4 of 7");
  assert.equal(progressText({ done: 2, total: 3 }), null, "segments show");
  assert.equal(progressText(null), null);
});

test("job parser accepts every field and optional launching turn", () => {
  const event = jobEvent({
    model: "gpt-6.1-sol",
    title: "Fix it",
    turn: "launch:1",
    trigger: TRIGGER,
  });
  const head = parseTaskStatus(event);
  assert.deepEqual(head, {
    eventId: event.id,
    author: AGENT,
    createdAt: 1000,
    channelId: CH,
    ns: "job",
    jobId: "j1",
    role: "coder",
    model: "gpt-6.1-sol",
    title: "Fix it",
    turnId: "launch:1",
    state: "running",
    started: 900,
    ended: null,
    trigger: TRIGGER,
    reason: null,
  });
  assert.equal(parseTaskStatus(jobEvent()).turnId, null);
  assert.equal(parseTaskStatus(jobEvent({ state: "done" })).ended, 1000);
});

test("job parser rejects invalid ids roles bindings and lifecycle fields", () => {
  for (const overrides of [
    { dChannel: CH_B },
    { channel: `${CH}\n` },
    { jobId: "a:b" },
    { jobId: "x".repeat(65) },
    { jobId: "" },
    { jobId: "j1\n" },
    { role: null },
    { role: "Coder!" },
    { role: "x".repeat(33) },
    { role: "coder\n" },
    { ended: 1000 },
    { state: "done", ended: null },
    { state: "done", ended: 899 },
    { state: "done", reason: "timeout" },
    { state: "paused", ended: 1000 },
    { content: "note" },
    { extra: [["progress", "1", "2"]] },
    { extra: [["session", "0"]] },
    { turn: "bad id" },
    { turn: "t1", extra: [["turn", "t2"]] },
    { model: "bad id" },
    { model: "x".repeat(65) },
    { model: "gpt\n" },
    { title: "é".repeat(121) },
    { trigger: "BAD" },
    { reason: "é".repeat(33), state: "error" },
    { extra: [["role", "tester"]] },
    {
      extra: [
        ["model", "gpt"],
        ["model", "glm"],
      ],
    },
  ])
    assert.equal(
      parseTaskStatus(jobEvent(overrides)),
      null,
      JSON.stringify(overrides),
    );
  assert.ok(
    parseTaskStatus(
      jobEvent({
        jobId: "x".repeat(64),
        role: "x".repeat(32),
        model: "x".repeat(64),
        title: "é".repeat(120),
      }),
    ),
  );
});

test("three jobs in one author channel stay independent of turn stores and replace by NIP order", () => {
  const store = fold(
    jobEvent({ jobId: "j1" }),
    jobEvent({ jobId: "j2" }),
    jobEvent({ jobId: "j3" }),
  );
  assert.equal(store.jobs.size, 3);
  assert.equal(store.current.size, 0);
  assert.equal(store.ended.size, 0);
  assert.equal(store.details.size, 0);
  const newer = foldStatus(store, [
    parseTaskStatus(jobEvent({ jobId: "j1", state: "done", at: 1002 })),
  ]);
  const stale = foldStatus(newer, [
    parseTaskStatus(jobEvent({ jobId: "j1", at: 1001 })),
  ]);
  assert.equal(stale, newer);
  assert.equal(jobsRunning(stale, 1100).length, 2);
  assert.equal(jobsFinished(stale, 0, 1100)[0].state, "done");
  const tied = foldStatus(store, [
    parseTaskStatus(
      jobEvent({ jobId: "j1", id: "0", at: 1000, title: "lower wins" }),
    ),
  ]);
  assert.equal(
    [...tied.jobs.values()].find((h) => h.jobId === "j1").title,
    "lower wins",
  );
});

test("jobs prune below the day floor and retain triggers for queued suppression", () => {
  const store = fold(jobEvent({ trigger: TRIGGER, at: 1000 }));
  assert.ok(statusTriggers(store).get(AGENT).has(TRIGGER));
  assert.equal(pruneStatus(store, 1000), store);
  assert.equal(pruneStatus(store, 1001).jobs.size, 0);
  assert.equal(jobsFinished(store, 1001, 2000).length, 0);
});

test("engine labels are deterministic by model prefix", () => {
  for (const [model, label] of [
    ["gpt-6.1-sol", "GPT"],
    ["GPT-5", "GPT"],
    ["o3", "GPT"],
    ["claude-opus", "Claude"],
    ["opus-5", "Claude"],
    ["sonnet", "Claude"],
    ["haiku", "Claude"],
    ["fable", "Claude"],
    ["glm-5.2", "GLM"],
    [null, null],
    ["other/model", "other/model"],
  ]) {
    assert.equal(engineLabel(model), label);
  }
});

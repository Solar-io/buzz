import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_STATUS_STORE,
  foldStatus,
  parseTaskStatus,
} from "./taskStatus.ts";
import { askFor, buildWorkFeed, previewLine } from "./workFeed.ts";

const OWNED = "aa".repeat(32);
const NOT_OWNED = "bb".repeat(32);
const NOW = 10_000;

const EMPTY_NEEDS = {
  interviews: [],
  inboxItems: [],
  approvals: [],
  reminders: [],
};

function frame(kind, createdAt, channelId, turnId = "t1") {
  return {
    id: `env-${createdAt}`,
    createdAt,
    seq: createdAt,
    timestamp: "",
    kind,
    agentIndex: 0,
    channelId,
    sessionId: "s",
    turnId,
    startedAt: null,
    payload: null,
  };
}

function reaction(id, emoji, target, createdAt, author) {
  return {
    id,
    kind: 7,
    pubkey: author,
    created_at: createdAt,
    tags: [["e", target]],
    content: emoji,
  };
}

function inputs(overrides) {
  return {
    needs: EMPTY_NEEDS,
    observer: new Map(),
    dismissedTurns: new Set(),
    reactions: [],
    targets: new Map(),
    metrics: { state: "loading" },
    status: { state: "loading", store: EMPTY_STATUS_STORE, sinceS: 0 },
    ...overrides,
  };
}

test("an observer turn wins over a 💬 row for the same agent and channel", () => {
  const feed = buildWorkFeed(
    inputs({
      observer: new Map([[OWNED, [frame("turn_started", NOW - 5, "chan-1")]]]),
      reactions: [
        // The owned agent's 💬 in the same channel: covered by the turn.
        reaction("r1", "💬", "msg-1", NOW - 5, OWNED),
        // The owned agent in ANOTHER channel: its own reaction row.
        reaction("r2", "💬", "msg-2", NOW - 4, OWNED),
        // An agent the viewer does not own: reaction row, no timing claim.
        reaction("r3", "💬", "msg-3", NOW - 3, NOT_OWNED),
        // Its second triggering event in the same channel folds into one row.
        reaction("r4", "💬", "msg-4", NOW - 2, NOT_OWNED),
      ],
      targets: new Map([
        ["msg-1", { channelId: "chan-1" }],
        ["msg-2", { channelId: "chan-2" }],
        ["msg-3", { channelId: "chan-3" }],
        ["msg-4", { channelId: "chan-3" }],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.deepEqual(
    feed.running.map((row) => [
      row.source,
      row.agentPubkey,
      row.channelId,
      row.state,
    ]),
    [
      ["observer", OWNED, "chan-1", "live"],
      ["reaction", OWNED, "chan-2", "reacting"],
      ["reaction", NOT_OWNED, "chan-3", "reacting"],
    ],
  );
  assert.equal(feed.running[2].lastBeatAt, null, "no heartbeat claim");
});

test("scope This channel narrows running, queued and done too", () => {
  const feed = buildWorkFeed(
    inputs({
      observer: new Map([
        [
          OWNED,
          [
            frame("turn_started", NOW - 5, "chan-1", "a"),
            frame("turn_started", NOW - 5, "chan-2", "b"),
          ],
        ],
      ]),
      reactions: [
        reaction("q1", "👀", "msg-9", NOW - 30, NOT_OWNED),
        reaction("q2", "👀", "msg-8", NOW - 20, NOT_OWNED),
      ],
      targets: new Map([
        ["msg-9", { channelId: "chan-1" }],
        ["msg-8", { channelId: "chan-2" }],
      ]),
      metrics: {
        state: "ready",
        sinceS: 0,
        entries: [
          {
            locked: false,
            eventId: "m1",
            agentPubkey: OWNED,
            createdAt: NOW - 100,
            channelId: "chan-2",
            turnId: "done-1",
            at: NOW - 100,
            stopReason: "end_turn",
          },
        ],
      },
    }),
    NOW,
    "channel",
    "chan-1",
  );
  assert.deepEqual(
    feed.running.map((row) => row.channelId),
    ["chan-1"],
  );
  assert.deepEqual(
    feed.queued.map((row) => row.eventId),
    ["msg-9"],
  );
  assert.equal(feed.done.state, "ready");
  assert.equal(feed.done.count, 0, "the finished turn was in chan-2");
});

// ---- Phase 8: 30624 task status ------------------------------------------------

const CH = "0f5c1e8a-2b3d-4c5e-8f60-718293a4b5c6";

function statusHead(author, turn, state, at, extra = []) {
  return parseTaskStatus({
    id: `${author.slice(0, 2)}${at}`.padEnd(64, "0"),
    pubkey: author,
    kind: 30624,
    created_at: at,
    tags: [
      ["d", `turn:${CH}`],
      ["h", CH],
      ["turn", turn],
      ["state", state],
      ["started", String(at - 60)],
      ...(state === "running" ? [] : [["ended", String(at)]]),
      ...extra,
    ],
    content: "",
  });
}

function statusInput(heads, state = "ready", sinceS = 0) {
  for (const head of heads) {
    assert.ok(head, "fixture head parses");
  }
  return { state, store: foldStatus(EMPTY_STATUS_STORE, heads), sinceS };
}

test("a status head speaks for an agent's 💬, and its trigger is not queued", () => {
  const target = "c1".repeat(32);
  const feed = buildWorkFeed(
    inputs({
      reactions: [
        reaction("r1", "💬", "msg-1", NOW - 50, NOT_OWNED),
        reaction("q1", "👀", target, NOW - 70, NOT_OWNED),
      ],
      targets: new Map([
        ["msg-1", { channelId: CH }],
        [target, { channelId: CH }],
      ]),
      status: statusInput([
        statusHead(NOT_OWNED, "t1", "running", NOW - 20, [
          ["e", target, "", "trigger"],
        ]),
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.deepEqual(
    feed.running.map((row) => [row.source, row.agentPubkey, row.state]),
    [["status", NOT_OWNED, "live"]],
    "one row for the agent, from status — not a second 💬 row",
  );
  assert.deepEqual(feed.queued, [], "the 👀 it answered is picked up");
});

test("a 💬 NEWER than the agent's finished status head is still work", () => {
  const feed = buildWorkFeed(
    inputs({
      reactions: [reaction("r1", "💬", "msg-1", NOW - 10, NOT_OWNED)],
      targets: new Map([["msg-1", { channelId: CH }]]),
      status: statusInput([statusHead(NOT_OWNED, "t0", "done", NOW - 300)]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.deepEqual(
    feed.running.map((row) => row.source),
    ["reaction"],
  );
});

test("Done today: status alone is enough; neither source settled is not a 0", () => {
  const finished = statusInput(
    [statusHead(NOT_OWNED, "t1", "done", NOW - 30)],
    "ready",
    NOW - 1_000,
  );
  const locked = buildWorkFeed(
    inputs({ metrics: { state: "locked" }, status: finished }),
    NOW,
    "everywhere",
    null,
  );
  assert.equal(locked.done.state, "ready");
  assert.equal(locked.done.count, 1, "readable without the owner's key");

  const waiting = buildWorkFeed(
    inputs({
      metrics: { state: "locked" },
      status: { ...finished, state: "loading" },
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.equal(waiting.done.state, "loading");

  const neither = buildWorkFeed(
    inputs({
      metrics: { state: "locked" },
      status: { ...finished, state: "unavailable" },
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.equal(neither.done.state, "locked");
});

// ---- the ask: what each row is about when its agent set no title -------------

const SAM = "5a".repeat(32);

test("previewLine keeps the first non-empty line, collapsed and capped", () => {
  assert.equal(
    previewLine("\n\n  fix   the\trail  \nsecond line"),
    "fix the rail",
  );
  assert.equal(previewLine("   \n \n"), "");
  const long = previewLine("x".repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("askFor needs a fetched target with an author and some text", () => {
  const targets = new Map([
    ["a", { channelId: CH, authorPubkey: SAM, preview: "do option 1" }],
    ["b", { channelId: CH }],
    ["c", { channelId: CH, authorPubkey: SAM, preview: "" }],
  ]);
  assert.deepEqual(askFor(targets, "a"), {
    authorPubkey: SAM,
    text: "do option 1",
  });
  assert.equal(askFor(targets, "b"), null, "channel-only target");
  assert.equal(askFor(targets, "c"), null, "empty message");
  assert.equal(askFor(targets, "missing"), null);
  assert.equal(askFor(targets, null), null);
});

test("Running, Queued and Done rows carry the message that started them", () => {
  const runTrigger = "d1".repeat(32);
  const doneTrigger = "d2".repeat(32);
  const queuedTarget = "d3".repeat(32);
  const reactTarget = "d4".repeat(32);
  const OTHER = "cc".repeat(32);
  const feed = buildWorkFeed(
    inputs({
      reactions: [
        reaction("q1", "👀", queuedTarget, NOW - 70, NOT_OWNED),
        reaction("r1", "💬", reactTarget, NOW - 40, "dd".repeat(32)),
      ],
      targets: new Map([
        [
          runTrigger,
          { channelId: CH, authorPubkey: SAM, preview: "fix the rail" },
        ],
        [doneTrigger, { channelId: CH, authorPubkey: SAM, preview: "ship it" }],
        [
          queuedTarget,
          { channelId: CH, authorPubkey: SAM, preview: "next up" },
        ],
        [
          reactTarget,
          { channelId: "chan-9", authorPubkey: SAM, preview: "no lifecycle" },
        ],
      ]),
      status: statusInput([
        statusHead(NOT_OWNED, "t1", "running", NOW - 20, [
          ["e", runTrigger, "", "trigger"],
        ]),
        statusHead(OTHER, "t2", "done", NOW - 30, [
          ["e", doneTrigger, "", "trigger"],
        ]),
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.deepEqual(
    feed.running.map((row) => [row.source, row.ask?.text ?? null]),
    [
      ["status", "fix the rail"],
      ["reaction", "no lifecycle"],
    ],
  );
  assert.equal(feed.running[0].ask.authorPubkey, SAM);
  assert.deepEqual(
    feed.queued.map((row) => row.ask?.text ?? null),
    ["next up"],
  );
  assert.equal(feed.done.state, "ready");
  assert.deepEqual(
    feed.done.rows.map((row) => row.ask?.text ?? null),
    ["ship it"],
  );
  assert.equal(feed.done.last.ask.text, "ship it", "the folded summary too");
});

test("a row whose trigger is not fetched yet has no ask", () => {
  const feed = buildWorkFeed(
    inputs({
      status: statusInput([
        statusHead(NOT_OWNED, "t1", "running", NOW - 20, [
          ["e", "e1".repeat(32), "", "trigger"],
        ]),
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.equal(feed.running.length, 1);
  assert.equal(feed.running[0].ask, null);
});

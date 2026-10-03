import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_STATUS_STORE,
  foldStatus,
  parseTaskStatus,
} from "./taskStatus.ts";
import { askFor, buildWorkFeed, previewLine } from "./workFeed.ts";
import { activitySlot } from "./workActivity.ts";
import { whatLine } from "../ui/whatLine.ts";

import { jobEvent } from "./jobFixture.mjs";

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

function message(id, at, content, overrides = {}) {
  return {
    id,
    kind: 9,
    pubkey: NOT_OWNED,
    created_at: at,
    tags: [["h", CH]],
    content,
    ...overrides,
  };
}

const profiles = new Map([[SAM, { displayName: "Sam" }]]);

test("running row uses the agent's latest own in-window message without a name prefix", () => {
  const feed = buildWorkFeed(
    inputs({
      status: statusInput([statusHead(NOT_OWNED, "t1", "running", NOW - 20)]),
      agentActivity: new Map([
        [
          activitySlot(NOT_OWNED, CH),
          [
            message(
              "later",
              NOW - 5,
              "✳️ **Updates:** Testing the TestFlight build",
            ),
            message("pickup", NOW - 80, "Picked up: Cut a TestFlight build"),
            message("wrong-author", NOW, "Someone else's work", {
              pubkey: SAM,
            }),
            message("wrong-channel", NOW, "Elsewhere", {
              tags: [["h", "elsewhere"]],
            }),
            message("wrong-kind", NOW, "Not a chat message", { kind: 40002 }),
          ],
        ],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  const row = feed.running[0];
  assert.equal(row.startedAt, NOW - 80);
  assert.equal(row.latest, "Testing the TestFlight build");
  assert.equal(
    whatLine(row.title, row.ask, profiles, row.latest),
    "Testing the TestFlight build",
  );
});

test("running row ignores a message before startedAt and keeps its trigger fallback", () => {
  const trigger = "d1".repeat(32);
  const feed = buildWorkFeed(
    inputs({
      status: statusInput([
        statusHead(NOT_OWNED, "t1", "running", NOW - 20, [["e", trigger]]),
      ]),
      targets: new Map([
        [
          trigger,
          {
            channelId: CH,
            authorPubkey: SAM,
            preview: "Cut a TestFlight build off main",
          },
        ],
      ]),
      agentActivity: new Map([
        [
          activitySlot(NOT_OWNED, CH),
          [message("old", NOW - 81, "Previous turn")],
        ],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  const row = feed.running[0];
  assert.equal(row.latest, null);
  assert.equal(
    whatLine(row.title, row.ask, profiles, row.latest),
    "Sam: Cut a TestFlight build off main",
  );
});

test("done row uses the last own message through endedAt plus 30 seconds", () => {
  const feed = buildWorkFeed(
    inputs({
      status: statusInput([statusHead(NOT_OWNED, "t1", "done", NOW - 40)]),
      agentActivity: new Map([
        [
          activitySlot(NOT_OWNED, CH),
          [
            message("too-late", NOW - 9, "Next turn"),
            message(
              "last",
              NOW - 10,
              "**TestFlight build uploaded**\nDetails here",
            ),
            message("earlier", NOW - 50, "Picked up: TestFlight build"),
            message("too-early", NOW - 101, "Previous turn"),
          ],
        ],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  const row = feed.done.rows[0];
  assert.equal(row.startedAt, NOW - 100);
  assert.equal(row.endedAt, NOW - 40);
  assert.equal(row.latest, "TestFlight build uploaded");
  assert.equal(feed.done.last.latest, row.latest);
  assert.equal(
    whatLine(row.title, row.ask, profiles, row.latest),
    "TestFlight build uploaded",
  );
});

test("merged done row uses status end time even when its metric arrives later", () => {
  const feed = buildWorkFeed(
    inputs({
      status: statusInput([statusHead(NOT_OWNED, "t1", "done", NOW - 100)]),
      metrics: {
        state: "ready",
        sinceS: 0,
        entries: [
          {
            locked: false,
            eventId: "m1",
            agentPubkey: NOT_OWNED,
            createdAt: NOW,
            channelId: CH,
            turnId: "t1",
            at: NOW,
            stopReason: "end_turn",
          },
        ],
      },
      agentActivity: new Map([
        [
          activitySlot(NOT_OWNED, CH),
          [
            message("last", NOW - 80, "Finished that turn"),
            message("late", NOW - 60, "Next turn's work"),
          ],
        ],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.equal(feed.done.count, 1);
  assert.equal(feed.done.rows[0].latest, "Finished that turn");
});

test("metric-only done row uses at minus 3600 through at plus 30", () => {
  const feed = buildWorkFeed(
    inputs({
      metrics: {
        state: "ready",
        sinceS: 0,
        entries: [
          {
            locked: false,
            eventId: "m1",
            agentPubkey: NOT_OWNED,
            createdAt: NOW - 40,
            channelId: CH,
            turnId: "t1",
            at: NOW - 40,
            stopReason: "end_turn",
          },
        ],
      },
      agentActivity: new Map([
        [
          activitySlot(NOT_OWNED, CH),
          [
            message("last", NOW - 10, "Done within grace"),
            message("late", NOW - 9, "After grace"),
            message("early", NOW - 3641, "Before lookback"),
          ],
        ],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.equal(feed.done.rows[0].latest, "Done within grace");
});

test('a short trigger "Yes" uses its reply parent on running, queued and done rows', () => {
  const trigger = "d1".repeat(32);
  const targets = new Map([
    [
      trigger,
      {
        channelId: CH,
        authorPubkey: SAM,
        preview: "**Yes**",
        replyParentId: "parent",
      },
    ],
    [
      "parent",
      {
        channelId: CH,
        authorPubkey: SAM,
        preview: "🙋 Question: Cut a TestFlight build off main?",
      },
    ],
  ]);
  const feed = buildWorkFeed(
    inputs({
      targets,
      status: statusInput([
        statusHead(NOT_OWNED, "t1", "running", NOW - 20, [["e", trigger]]),
        statusHead(OWNED, "t2", "done", NOW - 30, [["e", trigger]]),
      ]),
      reactions: [reaction("q1", "👀", trigger, NOW - 10, "cc".repeat(32))],
    }),
    NOW,
    "everywhere",
    null,
  );
  for (const row of [feed.running[0], feed.queued[0], feed.done.rows[0]]) {
    assert.equal(
      whatLine(row.title, row.ask, profiles, row.latest),
      "Sam: Cut a TestFlight build off main?",
    );
  }
});

test("a long trigger keeps its text even when a parent is fetched", () => {
  const ask = askFor(
    new Map([
      [
        "trigger",
        {
          channelId: CH,
          authorPubkey: SAM,
          preview: "Cut a TestFlight build off main",
          replyParentId: "parent",
        },
      ],
      [
        "parent",
        {
          channelId: CH,
          authorPubkey: NOT_OWNED,
          preview: "Unrelated earlier request",
        },
      ],
    ]),
    "trigger",
  );
  assert.equal(
    whatLine(null, ask, profiles),
    "Sam: Cut a TestFlight build off main",
  );
});

test("short triggers keep their text when their parent is missing or unusable", () => {
  const target = {
    channelId: CH,
    authorPubkey: SAM,
    preview: "Yes",
    replyParentId: "parent",
  };
  for (const parent of [
    undefined,
    { channelId: CH, preview: "" },
    {
      channelId: "elsewhere",
      authorPubkey: SAM,
      preview: "Other channel's work",
    },
  ]) {
    const targets = new Map([["trigger", target]]);
    if (parent) targets.set("parent", parent);
    assert.equal(
      whatLine(null, askFor(targets, "trigger"), profiles),
      "Sam: Yes",
    );
  }
});

test("the 30624 title still wins over agent activity and trigger text", () => {
  const head = statusHead(NOT_OWNED, "t1", "running", NOW - 20);
  const detail = parseTaskStatus({
    id: "a".repeat(64),
    pubkey: NOT_OWNED,
    kind: 30624,
    created_at: NOW - 10,
    tags: [
      ["d", `detail:${CH}`],
      ["h", CH],
      ["turn", "t1"],
      ["title", "TestFlight release"],
    ],
    content: "",
  });
  const feed = buildWorkFeed(
    inputs({
      status: statusInput([head, detail]),
      agentActivity: new Map([
        [
          activitySlot(NOT_OWNED, CH),
          [message("pickup", NOW - 5, "Picked up: Build")],
        ],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  const row = feed.running[0];
  assert.equal(row.latest, "Picked up: Build");
  assert.equal(
    whatLine(row.title, row.ask, profiles, row.latest),
    "TestFlight release",
  );
  assert.equal(
    whatLine(null, null, profiles),
    null,
    "rendering does not wait for messages",
  );
});

test("a background job never suppresses the seat reaction or borrows its latest chat", () => {
  const event = jobEvent({
    at: NOW,
    model: "gpt-6.1-sol",
    title: "Background",
  });
  const ch = event.tags.find((t) => t[0] === "h")[1];
  const feed = buildWorkFeed(
    inputs({
      status: {
        state: "ready",
        store: foldStatus(EMPTY_STATUS_STORE, [parseTaskStatus(event)]),
        sinceS: 0,
      },
      reactions: [reaction("r-job", "💬", "ask-turn", NOW - 5, OWNED)],
      targets: new Map([["ask-turn", { channelId: ch }]]),
      agentActivity: new Map([
        [
          activitySlot(OWNED, ch),
          [
            {
              id: "chat",
              pubkey: OWNED,
              kind: 9,
              created_at: NOW,
              tags: [["h", ch]],
              content: "Seat chat",
            },
          ],
        ],
      ]),
    }),
    NOW,
    "everywhere",
    null,
  );
  assert.equal(feed.running.length, 2);
  assert.deepEqual(
    feed.running.map((row) => row.source),
    ["job", "reaction"],
  );
  assert.equal(feed.running[0].latest, null);
  assert.equal(feed.running[0].title, "Background");
});

test("finished jobs count in Done only after the status REQ is ready", () => {
  const store = foldStatus(EMPTY_STATUS_STORE, [
    parseTaskStatus(jobEvent({ state: "done", at: NOW })),
  ]);
  for (const [state, count] of [
    ["ready", 1],
    ["loading", 0],
  ]) {
    const feed = buildWorkFeed(
      inputs({
        status: { state, store, sinceS: 0 },
        metrics: { state: "ready", entries: [], sinceS: 0 },
      }),
      NOW,
      "everywhere",
      null,
    );
    assert.equal(feed.done.count, count);
    assert.equal(feed.running.length, 0);
  }
});

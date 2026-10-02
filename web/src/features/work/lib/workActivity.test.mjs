import assert from "node:assert/strict";
import { test } from "node:test";
import { activityQueries, mergeActivityMessages } from "./workActivity.ts";

const run = (
  agentPubkey = "agent",
  channelId = "channel",
  startedAt = 100,
) => ({
  key: `turn:${agentPubkey}`,
  agentPubkey,
  channelId,
  startedAt,
});
const done = (
  agentPubkey = "agent",
  channelId = "channel",
  at = 90,
  startedAt = 50,
) => ({
  key: `${agentPubkey}:${at}`,
  agentPubkey,
  channelId,
  at,
  startedAt,
});
const feed = (running = [], rows = []) => ({
  running,
  done: { state: "ready", rows },
});

test("agent history uses one scoped REQ per pair and distinct turn windows", () => {
  const queries = activityQueries(feed([run()], [done()]), 120);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].filters, [
    { kinds: [9], authors: ["agent"], "#h": ["channel"], since: 100, limit: 5 },
    {
      kinds: [9],
      authors: ["agent"],
      "#h": ["channel"],
      since: 50,
      until: 120,
      limit: 5,
    },
  ]);
});

test("only running query keys refresh each minute", () => {
  const running = feed([run()]);
  assert.equal(
    activityQueries(running, 120)[0].key,
    activityQueries(running, 179)[0].key,
  );
  assert.notEqual(
    activityQueries(running, 120)[0].key,
    activityQueries(running, 180)[0].key,
  );
  const ended = feed([], [done()]);
  assert.equal(
    activityQueries(ended, 120)[0].key,
    activityQueries(ended, 180)[0].key,
  );
});

test("queries cap at 30 pairs and ten filters per pair, skipping unknown channels", () => {
  assert.equal(
    activityQueries(
      feed(Array.from({ length: 40 }, (_, i) => run(`a${i}`))),
      120,
    ).length,
    30,
  );
  const queries = activityQueries(
    feed(
      [run()],
      Array.from({ length: 20 }, (_, i) => done("agent", "channel", i, 0)),
    ),
    120,
  );
  assert.equal(queries.length, 1);
  assert.equal(queries[0].filters.length, 10);
  assert.deepEqual(
    activityQueries(feed([run("a", null), run("b", "c", null)]), 120),
    [],
  );
});

test("activity cache keeps five per turn window, preserving older done messages", () => {
  const filters = activityQueries(
    feed([run()], [done("agent", "channel", 60, 0)]),
    120,
  )[0].filters;
  const events = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    pubkey: "agent",
    kind: 9,
    tags: [["h", "channel"]],
    created_at: i < 6 ? i : 100 + i,
    content: `Message ${i}`,
  }));
  const merged = mergeActivityMessages(events, [events[0]], filters);
  assert.equal(merged.length, 10);
  assert.deepEqual(
    merged.map((event) => event.created_at).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 107, 108, 109, 110, 111],
  );
});

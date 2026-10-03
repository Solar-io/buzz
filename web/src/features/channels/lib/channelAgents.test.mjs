import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelAgentCandidates,
  channelAgentTarget,
  partitionChannelMembers,
  runChannelAgentBatch,
  startAfterAttach,
  unregisteredChannelAgents,
} from "./channelAgents.ts";

const NOW = 1_800_000_000;
const key = (n) => n.toString(16).padStart(64, "0");
const agent = (n, name = `Agent ${n}`) => ({
  pubkey: key(n),
  name,
  updatedAt: NOW,
  model: "opus",
  effort: { acp: "medium" },
});
const catalog = (agents, extra = {}) => ({
  machine: "crichton.local",
  version: 4,
  updatedAt: NOW,
  agents,
  harnesses: [],
  ...extra,
});

test("partition recognizes registry, known identities and bot-role retired keys", () => {
  const members = [
    { pubkey: key(1) },
    { pubkey: key(2), role: "bot" },
    { pubkey: key(3) },
    { pubkey: key(4) },
  ];
  const result = partitionChannelMembers(
    members,
    [agent(1)],
    new Set([key(3)]),
  );
  assert.deepEqual(result.agents, members.slice(0, 3));
  assert.deepEqual(result.people, [members[3]]);
});
test("picker lists only agents not in the channel", () => {
  assert.deepEqual(
    channelAgentCandidates(
      [agent(1), agent(2), agent(3)],
      [{ pubkey: key(1) }],
      [catalog([key(1), key(2)])],
      NOW,
    ).map((entry) => entry.pubkey),
    [key(2)],
  );
});
test("unregistered = members no fresh v4 catalog claims", () => {
  const result = unregisteredChannelAgents(
    [{ pubkey: key(1) }, { pubkey: key(2) }, { pubkey: key(3) }],
    [agent(1), agent(2)],
    [
      catalog([key(1)]),
      catalog([key(2)], { machine: "old", updatedAt: NOW - 90_000 }),
    ],
    NOW,
  );
  assert.deepEqual(result.map((entry) => entry.pubkey).sort(), [
    key(2),
    key(3),
  ]);
});
test("missing, empty and pre-v4 claims never authorize cleanup", () => {
  for (const catalogs of [
    [],
    [catalog([])],
    [catalog([key(2)], { version: 3 })],
    [catalog([key(2)]), catalog([], { machine: "legacy", version: 3 })],
  ]) {
    assert.deepEqual(
      unregisteredChannelAgents(
        [{ pubkey: key(1) }],
        [agent(1)],
        catalogs,
        NOW,
      ),
      [],
    );
  }
});
test("claimed duplicate names are not removed from the channel", () => {
  assert.deepEqual(
    unregisteredChannelAgents(
      [{ pubkey: key(1) }, { pubkey: key(2) }],
      [agent(1, "Same"), agent(2, "Same")],
      [catalog([key(1), key(2)])],
      NOW,
    ),
    [],
  );
});
test("far-future catalog timestamps never authorize channel cleanup", () => {
  assert.deepEqual(
    unregisteredChannelAgents(
      [{ pubkey: key(2) }],
      [agent(2)],
      [catalog([key(1)], { updatedAt: NOW + 600 })],
      NOW,
    ),
    [],
  );
});
test("writes require exactly one recently reporting claiming desktop", () => {
  assert.equal(
    channelAgentTarget(key(1), [catalog([key(1)])], NOW),
    "crichton.local",
  );
  for (const catalogs of [
    [],
    [catalog([key(1)], { updatedAt: NOW - 8 * 3600 })],
    [catalog([key(1)], { updatedAt: NOW + 301 })],
    [catalog([key(1)]), catalog([key(1)], { machine: "other" })],
  ])
    assert.equal(channelAgentTarget(key(1), catalogs, NOW), null);
});
test("accepted attach precedes start for the same key with bot role", async () => {
  const calls = [];
  await startAfterAttach({
    channelId: "channel",
    pubkey: key(1),
    sendMember: async (event) => {
      calls.push(event);
      return { ok: true };
    },
    refresh() {},
    start: async (command) => {
      calls.push(command);
      return "request";
    },
  });
  assert.deepEqual(calls, [
    {
      kind: 9000,
      tags: [
        ["h", "channel"],
        ["p", key(1)],
        ["role", "bot"],
      ],
      content: "",
    },
    { action: "start", request: { pubkey: key(1) } },
  ]);
});
test("refused attach never sends start", async () => {
  let starts = 0;
  await assert.rejects(
    startAfterAttach({
      channelId: "channel",
      pubkey: key(1),
      sendMember: async () => ({ ok: false, message: "No permission" }),
      refresh() {},
      start: async () => {
        starts++;
        return "request";
      },
    }),
    /No permission/,
  );
  assert.equal(starts, 0);
});
test("start failure preserves accepted membership and refreshes it", async () => {
  let refreshed = 0;
  await assert.rejects(
    startAfterAttach({
      channelId: "channel",
      pubkey: key(1),
      sendMember: async () => ({ ok: true }),
      refresh() {
        refreshed++;
      },
      start: async () => {
        throw new Error("Cannot start");
      },
    }),
    /Cannot start/,
  );
  assert.equal(refreshed, 1);
});
test("batch concurrency is three and a partial refusal preserves successes", async () => {
  let active = 0,
    peak = 0;
  const applied = [];
  const result = await runChannelAgentBatch(
    [1, 2, 3, 4, 5, 6, 7],
    async (entry) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      applied.push(entry);
      if (entry === 2) throw new Error("Refused");
    },
  );
  assert.equal(peak, 3);
  assert.equal(applied.length, 7);
  assert.deepEqual(
    result.map(({ error }) => error),
    [null, "Refused", null, null, null, null, null],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rosterPosition,
  agentDesktopReady,
  agentNow,
  logsLockCopy,
  conversationModel,
} from "./agentScreenModel.ts";
import { addAgentChannel, removeAgentChannel } from "./agentChannelActions.ts";

const PUBKEY = "a".repeat(64);
const CHANNEL = "w9a-private-channel";

test("‹ › steps through roster order without wrapping at either edge", () => {
  const roster = ["c", "a", "b"].map((pubkey) => ({ pubkey }));
  assert.deepEqual(rosterPosition(roster, "a"), {
    position: 2,
    total: 3,
    previous: "c",
    next: "b",
  });
  assert.equal(rosterPosition(roster, "c").previous, null);
  assert.equal(rosterPosition(roster, "b").next, null);
  assert.deepEqual(rosterPosition(roster, "foreign"), {
    position: 0,
    total: 3,
    previous: null,
    next: null,
  });
});

test("Channels add publishes 9000 then start, waiting for membership acceptance", async () => {
  const calls = [];
  let accept;
  const acceptance = new Promise((resolve) => {
    accept = resolve;
  });
  const work = addAgentChannel({
    channelId: CHANNEL,
    pubkey: PUBKEY,
    sendMember: async (event) => {
      calls.push(event);
      return acceptance;
    },
    start: async (command) => {
      calls.push(command);
      return "start-request";
    },
    refresh: () => calls.push("refresh"),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    kind: 9000,
    tags: [
      ["h", CHANNEL],
      ["p", PUBKEY],
      ["role", "bot"],
    ],
    content: "",
  });
  accept({ ok: true });
  assert.equal(await work, "start-request");
  assert.deepEqual(calls.slice(1), [
    "refresh",
    { action: "start", request: { pubkey: PUBKEY } },
  ]);
});

test("a refused channel add never starts the agent or refreshes membership", async () => {
  let starts = 0;
  let refreshes = 0;
  await assert.rejects(
    addAgentChannel({
      channelId: CHANNEL,
      pubkey: PUBKEY,
      sendMember: async () => ({
        ok: false,
        message: "Channel admin required",
      }),
      start: async () => {
        starts++;
        return "bad";
      },
      refresh: () => refreshes++,
    }),
    /Channel admin required/,
  );
  assert.equal(starts, 0);
  assert.equal(refreshes, 0);
});

test("an accepted add still refreshes when starting fails, with an honest partial outcome", async () => {
  let refreshes = 0;
  await assert.rejects(
    addAgentChannel({
      channelId: CHANNEL,
      pubkey: PUBKEY,
      sendMember: async () => ({ ok: true }),
      start: async () => null,
      refresh: () => refreshes++,
    }),
    /Added to the channel, but the start command was not sent/,
  );
  assert.equal(refreshes, 1);
});

test("Channels removal publishes only scoped 9001 and refreshes after acceptance", async () => {
  const calls = [];
  await removeAgentChannel(
    CHANNEL,
    PUBKEY,
    async (event) => {
      calls.push(event);
      return { ok: true };
    },
    () => calls.push("refresh"),
  );
  assert.deepEqual(calls, [
    {
      kind: 9001,
      tags: [
        ["h", CHANNEL],
        ["p", PUBKEY],
      ],
      content: "",
    },
    "refresh",
  ]);
});

test("a refused removal preserves membership and surfaces the relay reason", async () => {
  let refreshed = false;
  await assert.rejects(
    removeAgentChannel(
      CHANNEL,
      PUBKEY,
      async () => ({ ok: false, message: "Not an admin" }),
      () => {
        refreshed = true;
      },
    ),
    /Not an admin/,
  );
  assert.equal(refreshed, false);
});

test("Logs tab is locked with update copy when read.log cap missing", () => {
  assert.equal(
    logsLockCopy("crichton.local"),
    "Update Buzz Desktop on crichton to view logs here.",
  );
  assert.equal(logsLockCopy(), "Update Buzz Desktop to view logs here.");
});

test("only a fresh matching single desktop report enables mutating controls", () => {
  const catalogs = [{ machine: "crichton.local", updatedAt: 10_000 }];
  assert.equal(agentDesktopReady(catalogs, ["crichton.local"], 10_001), true);
  assert.equal(agentDesktopReady(catalogs, ["other"], 10_001), false);
  assert.equal(agentDesktopReady(catalogs, [], 10_001), false);
  assert.equal(
    agentDesktopReady(catalogs, ["crichton.local", "other"], 10_001),
    false,
  );
  assert.equal(agentDesktopReady(catalogs, ["crichton.local"], 31_901), false);
  assert.equal(agentDesktopReady(catalogs, ["crichton.local"], 9_699), false);
});

function frame(kind, at, turnId = "turn-1", channelId = CHANNEL) {
  return {
    id: `${kind}-${at}`,
    kind,
    createdAt: at,
    turnId,
    channelId,
    payload: {},
    seq: at,
    startedAt: null,
  };
}
test("Right now finishes a turn on its terminal frame instead of treating it as working", () => {
  const started = frame("turn_started", 100);
  assert.equal(agentNow(PUBKEY, [started], 110).turns.length, 1);
  const ended = frame("turn_completed", 120);
  const result = agentNow(PUBKEY, [started, ended], 125);
  assert.equal(result.turns.length, 0);
  assert.equal(result.lastFinished, ended);
});
test("Right now keeps another conversation's turn after one finishes", () => {
  const result = agentNow(
    PUBKEY,
    [
      frame("turn_started", 100),
      frame("turn_started", 101, "turn-2", "other"),
      frame("turn_error", 110),
    ],
    115,
  );
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].channelId, "other");
  assert.equal(result.lastFinished.kind, "turn_error");
});
test("Right now exposes silence and chooses the newest finish regardless of frame arrival order", () => {
  const result = agentNow(
    PUBKEY,
    [
      frame("turn_completed", 90, "old"),
      frame("turn_started", 100),
      frame("turn_error", 80, "older"),
    ],
    130,
  );
  assert.equal(result.turns[0].state, "stalled");
  assert.equal(result.lastFinished.createdAt, 90);
});

test("the live model is the conversation's latest harness snapshot, not another channel or saved value", () => {
  const snapshot = (at, channelId, model) => ({
    ...frame("session_config_captured", at, "turn", channelId),
    payload: { models: { currentModelId: model } },
  });
  assert.equal(
    conversationModel(
      [
        snapshot(102, "other", "other-model"),
        snapshot(101, CHANNEL, "live-model"),
        snapshot(100, CHANNEL, "old-model"),
      ],
      CHANNEL,
    ),
    "live-model",
  );
  assert.equal(conversationModel([], CHANNEL), null);
  assert.equal(
    conversationModel(
      [snapshot(100, CHANNEL, "old-model"), snapshot(101, CHANNEL, null)],
      CHANNEL,
    ),
    null,
  );
});
test("the live model reads the ACP model config option when the models block is absent", () => {
  const captured = {
    ...frame("session_config_captured", 100),
    payload: {
      configOptions: [
        { category: "thought_level", currentValue: "high" },
        { category: "model", currentValue: "acp-model" },
      ],
    },
  };
  assert.equal(conversationModel([captured], CHANNEL), "acp-model");
  captured.payload.configOptions = [
    null,
    { category: "model", currentValue: 17 },
  ];
  assert.equal(conversationModel([captured], CHANNEL), null);
});

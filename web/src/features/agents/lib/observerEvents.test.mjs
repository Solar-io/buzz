import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentWorkingState,
  transcriptFromFrames,
  agentTurnStart,
  expandObserverFrame,
} from "./observerEvents.ts";

function frame(overrides = {}) {
  return {
    id: "f".repeat(62) + String(seqCounter++),
    createdAt: 1_000 + seqCounter,
    seq: seqCounter,
    timestamp: "",
    kind: "acp_read",
    channelId: "ch-1",
    payload: {},
    ...overrides,
  };
}

let seqCounter = 0;

function sessionUpdate(update, messageId = "m1") {
  return frame({
    payload: { method: "session/update", params: { update } },
    kind: "acp_read",
  });
}

test("thought chunks accumulate into one entry keyed by message id", () => {
  seqCounter = 0;
  const { entries } = transcriptFromFrames([
    sessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Let me " },
      messageId: "m1",
    }),
    sessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "check the file." },
      messageId: "m1",
    }),
  ]);
  const thoughts = entries.filter((e) => e.type === "thought");
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0].text, "Let me check the file.");
});

test("tool calls become titled rows with status; updates replace status", () => {
  seqCounter = 100;
  const { entries } = transcriptFromFrames([
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read file",
      status: "executing",
    }),
    sessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "Read file",
      status: "completed",
    }),
  ]);
  const tools = entries.filter((e) => e.type === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].title, "Read file");
  assert.equal(tools[0].status, "completed");
});

test("RPC noise is suppressed and counted, not rendered", () => {
  seqCounter = 200;
  const { entries, suppressed } = transcriptFromFrames([
    frame({ kind: "acp_write", payload: { method: "session/prompt" } }),
    frame({ kind: "acp_read", payload: { method: "session/other" } }),
    sessionUpdate({ sessionUpdate: "user_message_chunk", content: "echo" }),
    frame({ kind: "raw_json_rpc", payload: {} }),
  ]);
  assert.equal(entries.length, 0);
  assert.equal(suppressed, 4);
});

test("turn_started renders a divider entry", () => {
  seqCounter = 300;
  const { entries } = transcriptFromFrames([frame({ kind: "turn_started" })]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "turn");
});

test("string content passes through block text extraction", () => {
  seqCounter = 400;
  const { entries } = transcriptFromFrames([
    sessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: "plain string thought",
      messageId: "m2",
    }),
  ]);
  assert.equal(entries[0].text, "plain string thought");
});

test("agentWorkingState: turn newer than last reply means working", () => {
  seqCounter = 500;
  const { working, startedAt } = agentWorkingState(
    [frame({ kind: "turn_started", createdAt: 2000 })],
    1500,
    2010,
  );
  assert.equal(working, true);
  assert.equal(startedAt, 2000);
});

test("agentWorkingState: agent reply after turn start ends the turn", () => {
  seqCounter = 510;
  const { working } = agentWorkingState(
    [frame({ kind: "turn_started", createdAt: 2000 })],
    2100,
    2200,
  );
  assert.equal(working, false);
});

test("agentWorkingState: no frames or stale turns read as idle", () => {
  seqCounter = 520;
  assert.equal(agentWorkingState([], 0, 1000).working, false);
  const stale = agentWorkingState(
    [frame({ kind: "turn_started", createdAt: 1000 })],
    0,
    1000 + 400,
  );
  assert.equal(stale.working, false);
});

test("agentWorkingState: any frame newer than the last reply signals working", () => {
  seqCounter = 530;
  const { working, startedAt } = agentWorkingState(
    [
      sessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: "x",
        messageId: "m9",
      }),
    ],
    100,
    150,
  );
  assert.equal(working, true);
  assert.ok(startedAt !== null && startedAt > 100);
});

test("timer start is sticky: later frames do not reset it", () => {
  seqCounter = 540;
  const frames = [
    sessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: "a",
      messageId: "m1",
    }),
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read",
    }),
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Grep",
    }),
  ];
  const first = agentWorkingState(frames, 100, 150);
  const later = agentWorkingState(frames, 100, 160);
  assert.ok(first.startedAt !== null);
  assert.equal(first.startedAt, later.startedAt);
  assert.ok(later.working);
});

test("usage_update renders a Tokens line; commands/other updates stay suppressed", () => {
  seqCounter = 600;
  const { entries, suppressed } = transcriptFromFrames([
    sessionUpdate({
      sessionUpdate: "usage_update",
      used: 652259,
      size: 1_000_000,
      cost: { amount: 310.5979, currency: "USD" },
    }),
    sessionUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [],
    }),
  ]);
  const usage = entries.filter((e) => e.type === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].text, "Usage Tokens: 652259/1000000 ($310.5979 USD)");
  assert.ok(suppressed >= 1);
});

test("consecutive completed tools collapse into one burst; lone tools stay", () => {
  seqCounter = 610;
  const { entries } = transcriptFromFrames([
    sessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: "thinking",
      messageId: "m1",
    }),
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Terminal pending",
      status: "completed",
    }),
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "Read file",
      status: "completed",
    }),
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      title: "Grep",
      status: "completed",
    }),
    sessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: "more",
      messageId: "m2",
    }),
    sessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t4",
      title: "Solo",
      status: "completed",
    }),
  ]);
  const bursts = entries.filter((e) => e.type === "toolBurst");
  const tools = entries.filter((e) => e.type === "tool");
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].count, 3);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].title, "Solo");
});

test("retained history arriving newest-first still derives oldest-first order", () => {
  seqCounter = 620;
  // Relay replay order: newest frame first.
  const f1 = sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: "first thought ",
    messageId: "m1",
  });
  const f2 = sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: "second thought",
    messageId: "m2",
  });
  const newestFirst = [f2, f1];
  const { entries } = transcriptFromFrames(newestFirst);
  const thoughts = entries.filter((e) => e.type === "thought");
  assert.equal(thoughts.length, 2);
  assert.equal(thoughts[0].text, "first thought ");
  assert.equal(thoughts[1].text, "second thought");
});

test("batch envelopes expand into their nested events", () => {
  const envelope = {
    id: "env-1",
    createdAt: 1788214368,
    seq: 524705,
    timestamp: "2026-08-31T22:12:48.887Z",
    kind: "batch",
    agentIndex: 0,
    channelId: "ch-1",
    sessionId: "s-1",
    turnId: "t-1",
    startedAt: "2026-08-31T22:12:48.866Z",
    payload: {
      events: [
        {
          kind: "turn_started",
          timestamp: "2026-08-31T22:12:48.866Z",
          seq: 524701,
          channelId: "ch-1",
          turnId: "t-1",
          payload: { source: "channel" },
        },
        {
          kind: "session_resolved",
          timestamp: "2026-08-31T22:12:48.866Z",
          payload: { isNewSession: false },
        },
      ],
    },
  };
  const expanded = expandObserverFrame(envelope);
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0].kind, "turn_started");
  assert.equal(
    expanded[0].createdAt,
    1788214368 - 0,
    "nested timestamp parsed to seconds",
  );
  // Nested field falls back to the envelope's when missing.
  assert.equal(expanded[1].sessionId, "s-1");
  // Non-batch frames pass through untouched.
  const plain = { ...envelope, kind: "thought", payload: null };
  assert.equal(expandObserverFrame(plain).length, 1);
  // Batch with no/empty events passes through as itself.
  const empty = { ...envelope, payload: { events: [] } };
  assert.equal(expandObserverFrame(empty)[0].kind, "batch");
});

test("working state keys off turn_started INSIDE a batch after flattening", () => {
  const envelope = {
    id: "env-1",
    createdAt: 1788214368,
    seq: 1,
    timestamp: "",
    kind: "batch",
    agentIndex: 0,
    channelId: "ch-1",
    sessionId: null,
    turnId: "t-2",
    startedAt: null,
    payload: {
      events: [
        {
          kind: "turn_started",
          timestamp: "2026-08-31T22:12:48.866Z",
          payload: {},
        },
      ],
    },
  };
  const frames = [
    // Previous turn's tail — the frames that used to latch the timer.
    { kind: "thought", createdAt: 1788213340, channelId: "ch-1", id: "a" },
    ...expandObserverFrame(envelope),
    { kind: "tool_call", createdAt: 1788214390, channelId: "ch-1", id: "c" },
  ];
  const state = agentWorkingState(frames, 1788212958, 1788214404);
  assert.equal(state.working, true);
  assert.equal(state.startedAt, 1788214368, "turn start, not the 21:55 tail");
});

test("agentTurnStart finds the newest boundary for the sidebar badge", () => {
  const frames = [
    { kind: "thought", createdAt: 100, id: "a" },
    { kind: "turn_started", createdAt: 200, id: "b" },
    { kind: "tool_call", createdAt: 300, id: "c" },
    { kind: "turn_started", createdAt: 400, id: "d" },
  ];
  assert.equal(agentTurnStart(frames), 400);
  assert.equal(
    agentTurnStart([{ kind: "thought", createdAt: 1, id: "x" }]),
    null,
  );
});

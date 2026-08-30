import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWorkingState, transcriptFromFrames } from "./observerEvents.ts";

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

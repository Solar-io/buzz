import assert from "node:assert/strict";
import { test } from "node:test";
import { memberChannelIds } from "./agentChannels.ts";

const AGENT = "ab".repeat(32);
const OTHER = "cd".repeat(32);

function snapshot(d, members, created_at = 100, id = "5".repeat(64)) {
  return {
    tags: [["d", d], ...members.map((pubkey) => ["p", pubkey, "", "bot"])],
    created_at,
    id,
  };
}

test("a channel whose snapshot lists the agent is a member channel", () => {
  const ids = memberChannelIds(
    [snapshot("chan-a", [AGENT, OTHER]), snapshot("chan-b", [OTHER])],
    AGENT,
  );
  assert.deepEqual([...ids], ["chan-a"]);
});

test("a channel that never lists the agent is excluded", () => {
  assert.equal(memberChannelIds([snapshot("chan-b", [OTHER])], AGENT).size, 0);
});

test("a newer snapshot that removes the agent drops the channel, in either arrival order", () => {
  const old = snapshot("chan-a", [AGENT, OTHER], 100);
  const removed = snapshot("chan-a", [OTHER], 200, "9".repeat(64));
  assert.equal(memberChannelIds([old, removed], AGENT).size, 0);
  assert.equal(memberChannelIds([removed, old], AGENT).size, 0);
});

test("pubkey matching is case-insensitive", () => {
  const ids = memberChannelIds(
    [snapshot("chan-a", [AGENT.toUpperCase()])],
    AGENT,
  );
  assert.deepEqual([...ids], ["chan-a"]);
  assert.deepEqual(
    [...memberChannelIds([snapshot("chan-a", [AGENT])], AGENT.toUpperCase())],
    ["chan-a"],
  );
});

test("equal created_at: the lower event id wins", () => {
  const lowWithAgent = snapshot("chan-a", [AGENT], 100, "1".repeat(64));
  const highWithout = snapshot("chan-a", [OTHER], 100, "9".repeat(64));
  assert.deepEqual(
    [...memberChannelIds([highWithout, lowWithAgent], AGENT)],
    ["chan-a"],
  );
  const lowWithout = snapshot("chan-b", [OTHER], 100, "1".repeat(64));
  const highWithAgent = snapshot("chan-b", [AGENT], 100, "9".repeat(64));
  assert.equal(memberChannelIds([lowWithout, highWithAgent], AGENT).size, 0);
});

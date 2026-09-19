import assert from "node:assert/strict";
import { test } from "node:test";

const { eligibleDmAgentPubkey } = await import("./dmAgentCall.ts");

const SELF = "1".repeat(64);
const AGENT = "A".repeat(64);
const HUMAN = "2".repeat(64);

const input = (overrides = {}) => ({
  channelType: "dm",
  participantPubkeys: [SELF, AGENT],
  selfPubkey: SELF,
  knownAgentPubkeys: new Set([AGENT.toLowerCase()]),
  ...overrides,
});

test("eligibleDmAgentPubkey selects the one known agent in a 1:1 DM", () => {
  assert.equal(eligibleDmAgentPubkey(input()), AGENT);
});

test("a human DM and a group DM have no call target", () => {
  assert.equal(
    eligibleDmAgentPubkey(
      input({
        participantPubkeys: [SELF, HUMAN],
        knownAgentPubkeys: new Set(),
      }),
    ),
    null,
  );
  assert.equal(
    eligibleDmAgentPubkey(input({ participantPubkeys: [SELF, AGENT, HUMAN] })),
    null,
  );
});

test("the agent identity must be known before a call button can appear", () => {
  assert.equal(
    eligibleDmAgentPubkey(input({ knownAgentPubkeys: new Set() })),
    null,
  );
  assert.equal(
    eligibleDmAgentPubkey(
      input({ channelType: "stream", participantPubkeys: [SELF, AGENT] }),
    ),
    null,
  );
});

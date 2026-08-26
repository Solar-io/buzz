import assert from "node:assert/strict";
import test from "node:test";

import { resolveHeaderAgentActivity } from "./headerAgentActivity.ts";

const AGENT_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AGENT_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HUMAN_C =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

test("agentDm_opensThatAgent", () => {
  const state = resolveHeaderAgentActivity({
    channelType: "dm",
    dmParticipantPubkey: AGENT_A,
    dmParticipantIsAgent: true,
    dmParticipantCount: 1,
    workingAgentPubkeys: [],
    channelAgentPubkeys: [],
  });
  assert.equal(state.showButton, true);
  assert.equal(state.targetPubkey, AGENT_A);
});

test("humanDm_hidesButton", () => {
  const state = resolveHeaderAgentActivity({
    channelType: "dm",
    dmParticipantPubkey: HUMAN_C,
    dmParticipantIsAgent: false,
    dmParticipantCount: 1,
    workingAgentPubkeys: [],
    channelAgentPubkeys: [],
  });
  assert.equal(state.showButton, false);
  assert.equal(state.targetPubkey, null);
});

test("groupDm_hidesButtonEvenWhenFirstParticipantIsAgent", () => {
  const state = resolveHeaderAgentActivity({
    channelType: "dm",
    dmParticipantPubkey: AGENT_A,
    dmParticipantIsAgent: true,
    dmParticipantCount: 3,
    workingAgentPubkeys: [],
    channelAgentPubkeys: [],
  });
  assert.equal(state.showButton, false);
  assert.equal(state.targetPubkey, null);
});

test("channel_prefersLiveWorkingAgentOverSessionList", () => {
  const state = resolveHeaderAgentActivity({
    channelType: "stream",
    dmParticipantPubkey: null,
    dmParticipantIsAgent: false,
    dmParticipantCount: 0,
    workingAgentPubkeys: [AGENT_B],
    channelAgentPubkeys: [AGENT_A],
  });
  assert.equal(state.showButton, true);
  assert.equal(state.targetPubkey, AGENT_B);
});

test("channel_fallsBackToSessionAgentWhenNobodyIsWorking", () => {
  const state = resolveHeaderAgentActivity({
    channelType: "forum",
    dmParticipantPubkey: null,
    dmParticipantIsAgent: false,
    dmParticipantCount: 0,
    workingAgentPubkeys: [],
    channelAgentPubkeys: [AGENT_A],
  });
  assert.equal(state.showButton, true);
  assert.equal(state.targetPubkey, AGENT_A);
});

test("agentlessChannel_showsButtonWithNoTarget", () => {
  const state = resolveHeaderAgentActivity({
    channelType: "stream",
    dmParticipantPubkey: null,
    dmParticipantIsAgent: false,
    dmParticipantCount: 0,
    workingAgentPubkeys: [],
    channelAgentPubkeys: [],
  });
  assert.equal(state.showButton, true);
  assert.equal(state.targetPubkey, null);
});

test("agentDm_ignoresWorkingSignalFromOtherAgents", () => {
  const state = resolveHeaderAgentActivity({
    channelType: "dm",
    dmParticipantPubkey: AGENT_A,
    dmParticipantIsAgent: true,
    dmParticipantCount: 1,
    workingAgentPubkeys: [AGENT_B],
    channelAgentPubkeys: [AGENT_B],
  });
  assert.equal(state.targetPubkey, AGENT_A);
});

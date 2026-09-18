import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADD_MEMBER_KIND,
  buildHuddleAgentAddEvent,
  huddleAgentAddMessage,
  huddleAgentAddOutcome,
  huddleAgentAddPlan,
  HUDDLE_AGENT_ADD_REFUSED,
  MAX_HUDDLE_AGENTS,
  selectableHuddleAgents,
} from "./huddleAgents.ts";

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);
const HUMAN = "c".repeat(64);
const EPH = "eph-1";
const PARENT = "parent-1";

test("the add-member kind is 9000 and the cap is 20, hardcoded", () => {
  assert.equal(ADD_MEMBER_KIND, 9000);
  assert.equal(MAX_HUDDLE_AGENTS, 20);
});

test("an add-member event carries h, p and the bot role", () => {
  const built = buildHuddleAgentAddEvent({
    channelId: EPH,
    agentPubkey: AGENT,
  });
  assert.deepEqual(built.event, {
    kind: 9000,
    content: "",
    tags: [
      ["h", EPH],
      ["p", AGENT],
      ["role", "bot"],
    ],
  });
});

test("the role is bot, not member", () => {
  // "member" is the relay default and is what the generic template builder
  // sends; a huddle agent must be a bot or nothing downstream finds it.
  const built = buildHuddleAgentAddEvent({
    channelId: EPH,
    agentPubkey: AGENT,
  });
  const role = built.event.tags.find((tag) => tag[0] === "role");
  assert.deepEqual(role, ["role", "bot"]);
});

test("a pubkey is normalised to lowercase on the wire", () => {
  const built = buildHuddleAgentAddEvent({
    channelId: EPH,
    agentPubkey: AGENT.toUpperCase(),
  });
  assert.deepEqual(built.event.tags[1], ["p", AGENT]);
});

test("a malformed pubkey is refused", () => {
  const built = buildHuddleAgentAddEvent({
    channelId: EPH,
    agentPubkey: "not-a-key",
  });
  assert.equal(built.error, "agent pubkey must be 64 hex characters");
  assert.equal(built.event, undefined);
});

test("a 63-hex pubkey is refused, not truncated", () => {
  const built = buildHuddleAgentAddEvent({
    channelId: EPH,
    agentPubkey: "a".repeat(63),
  });
  assert.equal(built.event, undefined);
});

test("a missing channel id is refused", () => {
  const built = buildHuddleAgentAddEvent({ channelId: "", agentPubkey: AGENT });
  assert.equal(built.error, "channel id is required");
});

test("the plan adds to the ephemeral channel AND the parent", () => {
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
    agentPubkey: AGENT,
    currentAgentPubkeys: [],
    parentMemberPubkeys: [HUMAN],
  });
  assert.deepEqual(result.plan.ephemeral.tags[0], ["h", EPH]);
  assert.deepEqual(result.plan.parent.tags[0], ["h", PARENT]);
  assert.equal(result.plan.ephemeral.kind, 9000);
  assert.equal(result.plan.parent.kind, 9000);
});

test("an existing parent member is NOT re-added with a bot role", () => {
  // Rewriting an existing member's role is forbidden for non-admins
  // (desktop agents.rs:110-118), so the parent step must be skipped, not
  // merely retried.
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
    agentPubkey: AGENT,
    currentAgentPubkeys: [],
    parentMemberPubkeys: [HUMAN, AGENT],
  });
  assert.equal(result.plan.parent, null);
  assert.notEqual(result.plan.ephemeral, null);
});

test("parent-membership matching is case-insensitive", () => {
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
    agentPubkey: AGENT,
    currentAgentPubkeys: [],
    parentMemberPubkeys: [AGENT.toUpperCase()],
  });
  assert.equal(result.plan.parent, null);
});

test("no parent channel means the ephemeral add alone", () => {
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: null,
    agentPubkey: AGENT,
    currentAgentPubkeys: [],
    parentMemberPubkeys: [],
  });
  assert.equal(result.plan.parent, null);
  assert.deepEqual(result.plan.ephemeral.tags[0], ["h", EPH]);
});

test("an agent already in the huddle is refused", () => {
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
    agentPubkey: AGENT,
    currentAgentPubkeys: [AGENT],
    parentMemberPubkeys: [],
  });
  assert.equal(result.error, "that agent is already in this huddle");
  assert.equal(result.plan, undefined);
});

test("a full huddle refuses the add at the cap", () => {
  const full = Array.from({ length: 20 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
    agentPubkey: AGENT,
    currentAgentPubkeys: full,
    parentMemberPubkeys: [],
  });
  // Hardcoded 20 in the message, so raising MAX_HUDDLE_AGENTS cannot raise
  // this expectation along with it.
  assert.equal(result.error, "agent limit reached: 20 (max 20)");
});

test("one below the cap still plans an add", () => {
  const nearlyFull = Array.from({ length: 19 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
    agentPubkey: AGENT,
    currentAgentPubkeys: nearlyFull,
    parentMemberPubkeys: [],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.plan.ephemeral.kind, 9000);
});

test("a malformed agent pubkey is refused by the planner too", () => {
  const result = huddleAgentAddPlan({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
    agentPubkey: "zz",
    currentAgentPubkeys: [],
    parentMemberPubkeys: [],
  });
  assert.equal(result.error, "agent pubkey must be 64 hex characters");
});

test("the picker excludes agents already in the huddle", () => {
  const offered = selectableHuddleAgents(
    [
      { pubkey: AGENT, name: "Ada" },
      { pubkey: OTHER, name: "Bob" },
    ],
    [AGENT],
  );
  assert.deepEqual(
    offered.map((agent) => agent.name),
    ["Bob"],
  );
});

test("the picker's exclusion is case-insensitive", () => {
  const offered = selectableHuddleAgents(
    [{ pubkey: AGENT, name: "Ada" }],
    [AGENT.toUpperCase()],
  );
  assert.equal(offered.length, 0);
});

test("the picker drops registry rows with an unusable pubkey", () => {
  const offered = selectableHuddleAgents(
    [
      { pubkey: "bogus", name: "Broken" },
      { pubkey: OTHER, name: "Bob" },
    ],
    [],
  );
  assert.equal(offered.length, 1);
  assert.equal(offered[0].name, "Bob");
});

test("the picker sorts by name", () => {
  const offered = selectableHuddleAgents(
    [
      { pubkey: OTHER, name: "Zoe" },
      { pubkey: AGENT, name: "Ada" },
    ],
    [],
  );
  assert.deepEqual(
    offered.map((agent) => agent.name),
    ["Ada", "Zoe"],
  );
});

test("a clean add reads as a plain success", () => {
  assert.equal(
    huddleAgentAddMessage({
      agentName: "Ada",
      parentAttempted: true,
      parentOk: true,
    }),
    "Ada added to the huddle.",
  );
});

test("a skipped parent add is not reported as a failure", () => {
  assert.equal(
    huddleAgentAddMessage({
      agentName: "Ada",
      parentAttempted: false,
      parentOk: false,
    }),
    "Ada added to the huddle.",
  );
});

test("a failed parent add is surfaced without losing the success", () => {
  const message = huddleAgentAddMessage({
    agentName: "Ada",
    parentAttempted: true,
    parentOk: false,
    parentMessage: "restricted: not an admin",
  });
  assert.equal(
    message,
    "Ada added to the huddle, but the channel add failed: restricted: not an admin",
  );
});

test("a failed parent add with no detail still says what happened", () => {
  const message = huddleAgentAddMessage({
    agentName: "Ada",
    parentAttempted: true,
    parentOk: false,
  });
  assert.equal(message, "Ada added to the huddle, but the channel add failed.");
});

// ---------------------------------------------------------------------------
// V4 add-failure honesty (2026-09-18 QA defect): a failed add was an Enter
// that no-oped and a dismissal that buried the attempt. The outcome contract
// is pinned here: the failure toasts (the signal that outlives the dialog)
// and the staged entry survives.

test("huddleAgentAddOutcome: full success closes and toasts nothing", () => {
  const outcome = huddleAgentAddOutcome({
    ok: true,
    message: "Ada added to the huddle.",
  });
  assert.equal(outcome.close, true);
  assert.equal(outcome.clearEntry, false);
  assert.equal(outcome.error, null);
  assert.equal(outcome.notice, null);
  assert.equal(outcome.toast, null);
});

test("huddleAgentAddOutcome: partial success keeps the dialog open with its notice", () => {
  const outcome = huddleAgentAddOutcome({
    ok: true,
    message: "Ada added to the huddle, but the channel add failed: restricted",
  });
  assert.equal(outcome.close, false);
  // The huddle add landed, so the entry is spent.
  assert.equal(outcome.clearEntry, true);
  assert.equal(
    outcome.notice,
    "Ada added to the huddle, but the channel add failed: restricted",
  );
  assert.equal(outcome.error, null);
  assert.equal(outcome.toast, null);
});

test("huddleAgentAddOutcome: failure toasts the relay's verdict, naming that nothing was added", () => {
  const outcome = huddleAgentAddOutcome({
    ok: false,
    message: "quota exceeded; retry in 4s",
  });
  assert.equal(outcome.close, false);
  assert.equal(outcome.error, "quota exceeded; retry in 4s");
  assert.ok(outcome.toast, "a failed add must toast — silence was the defect");
  assert.equal(outcome.toast.message, "quota exceeded; retry in 4s");
  assert.equal(
    outcome.toast.description,
    "Nothing was added — the agent is not in this huddle yet.",
  );
});

test("huddleAgentAddOutcome: failure preserves the staged entry, dialog stays open", () => {
  // The still-staged add that never landed must not be discarded as if it
  // had: no close, no entry clear — the user can retry the same paste.
  const outcome = huddleAgentAddOutcome({
    ok: false,
    message: "quota exceeded; retry in 4s",
  });
  assert.equal(outcome.close, false, "a failed add must not close the dialog");
  assert.equal(
    outcome.clearEntry,
    false,
    "a failed add must not clear the staged entry",
  );
  assert.equal(outcome.notice, null);
});

test("huddleAgentAddOutcome: an empty failure message still says the add was refused", () => {
  const outcome = huddleAgentAddOutcome({ ok: false, message: "" });
  assert.equal(outcome.error, HUDDLE_AGENT_ADD_REFUSED);
  assert.equal(outcome.toast.message, HUDDLE_AGENT_ADD_REFUSED);
  assert.equal(
    outcome.toast.description,
    "Nothing was added — the agent is not in this huddle yet.",
  );
});

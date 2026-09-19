import assert from "node:assert/strict";
import { test } from "node:test";

const { runAgentCallFlow } = await import("./agentCallFlow.ts");

const PARENT = "dm-parent";
const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);

function harness({
  existingHuddleChannelId = null,
  connected = false,
  agentPubkeys = [],
  addResult = { ok: true, message: "agent added" },
  provisionResult = { ok: true, channelId: "huddle-1", message: "created" },
} = {}) {
  const phases = [];
  const calls = [];
  let observation = {
    huddleChannelId: existingHuddleChannelId,
    parentChannelId: existingHuddleChannelId ? PARENT : null,
    connected,
    status: connected ? "connected" : "idle",
    agentPubkeys: [...agentPubkeys],
  };
  let current = true;
  let cleaned = 0;
  let armed = 0;
  return {
    phases,
    calls,
    get armed() {
      return armed;
    },
    get cleaned() {
      return cleaned;
    },
    cancel() {
      current = false;
    },
    handlers: {
      observe: () => observation,
      setPhase: (phase) => phases.push(phase),
      provision: async () => provisionResult,
      requestJoin: (target) => {
        calls.push(["join", target]);
        observation = {
          ...observation,
          huddleChannelId: target.huddleChannelId,
          parentChannelId: target.parentChannelId,
          connected: true,
          status: "connected",
        };
        return { ok: true, message: "Joining…" };
      },
      addAgent: async (input) => {
        calls.push(["add", input]);
        if (addResult.ok) {
          observation = {
            ...observation,
            agentPubkeys: [input.agentPubkey],
          };
        }
        return addResult;
      },
      armVoice: () => {
        armed += 1;
      },
      waitFor: async (predicate) => predicate(observation),
      abortPartialCall: () => {
        cleaned += 1;
      },
      isCurrent: () => current,
    },
  };
}

function options(overrides = {}) {
  return {
    parentChannelId: PARENT,
    agentPubkey: AGENT,
    agentName: "Evie",
    ...overrides,
  };
}

test("one flow provisions, joins, admits the exact agent, then arms voice", async () => {
  const rig = harness();

  const result = await runAgentCallFlow(options(), rig.handlers);

  assert.deepEqual(result, { ok: true, message: "Evie is on the call." });
  assert.deepEqual(rig.phases, [
    "creating",
    "joining",
    "adding",
    "arming",
    "active",
  ]);
  assert.deepEqual(
    rig.calls.map(([kind]) => kind),
    ["join", "add"],
    "the transport room is joined before the agent membership add",
  );
  assert.equal(rig.calls[1][1].agentPubkey, AGENT);
  assert.equal(rig.armed, 1);
  assert.equal(rig.cleaned, 0);
});

test("a compatible existing room skips a duplicate add but still confirms the exact roster", async () => {
  const rig = harness({
    existingHuddleChannelId: "huddle-existing",
    connected: true,
    agentPubkeys: [AGENT],
  });

  const result = await runAgentCallFlow(
    options({ existingHuddleChannelId: "huddle-existing" }),
    rig.handlers,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    rig.calls.map(([kind]) => kind),
    ["join"],
  );
  assert.equal(rig.armed, 1);
});

test("another agent in a reused room is rejected and cleaned up", async () => {
  const rig = harness({
    existingHuddleChannelId: "huddle-wrong",
    connected: true,
    agentPubkeys: [OTHER],
  });

  const result = await runAgentCallFlow(
    options({ existingHuddleChannelId: "huddle-wrong" }),
    rig.handlers,
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /another agent/i);
  assert.equal(rig.armed, 0);
  assert.equal(rig.cleaned, 1);
});

test("a refused add is visible to the caller and never arms voice", async () => {
  const rig = harness({
    addResult: { ok: false, message: "membership refused" },
  });

  const result = await runAgentCallFlow(options(), rig.handlers);

  assert.deepEqual(result, { ok: false, message: "membership refused" });
  assert.equal(rig.armed, 0);
  assert.equal(rig.cleaned, 1);
});

test("a failed join is cleaned up without arming voice", async () => {
  const rig = harness({
    provisionResult: {
      ok: true,
      channelId: "huddle-retry",
      message: "created",
    },
  });
  rig.handlers.waitFor = async () => false;

  const result = await runAgentCallFlow(options(), rig.handlers);

  assert.equal(result.ok, false);
  assert.equal(rig.armed, 0);
  assert.equal(rig.cleaned, 1);
  assert.equal(
    rig.calls.some(([kind]) => kind === "add"),
    false,
  );
});

test("a stale permission or provisioning continuation cannot join or arm a later call", async () => {
  const rig = harness();
  const originalProvision = rig.handlers.provision;
  rig.handlers.provision = async () => {
    rig.cancel();
    return originalProvision();
  };

  const result = await runAgentCallFlow(options(), rig.handlers);

  assert.deepEqual(result, {
    ok: false,
    message: "The call request was cancelled.",
  });
  assert.equal(rig.calls.length, 0);
  assert.equal(rig.armed, 0);
});

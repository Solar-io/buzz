import assert from "node:assert/strict";
import test from "node:test";

import {
  createInputFromCommand,
  lifecycleCallsFromCommand,
  updateInputFromCommand,
} from "./ownerAdminAppliers.ts";
import { parseOwnerAdminCommand } from "./ownerAdminProtocol.ts";

/**
 * The anti-"parsed but dropped" suite. Phase 1 shipped with the protocol
 * parsing avatarUrl/timeouts that the applier then silently discarded; these
 * deep-equal pins hold every forwarding line in place. Builders are exercised
 * through the real parser (envelope → parse → builder), never hand-built
 * command objects, so a parser regression shows up here too.
 */

const PK = "ab".repeat(32);

function parsedUpdate(request) {
  const command = parseOwnerAdminCommand({
    type: "agent_admin_command",
    action: "update",
    requestId: "r1",
    request,
  });
  if (!command) {
    throw new Error("update envelope failed to parse");
  }
  return command;
}

function parsedCreate(request) {
  const command = parseOwnerAdminCommand({
    type: "agent_admin_command",
    action: "create",
    requestId: "r1",
    request,
  });
  if (!command) {
    throw new Error("create envelope failed to parse");
  }
  return command;
}

test("create_input_forwards_timeouts", () => {
  const input = createInputFromCommand(
    parsedCreate({
      name: "N",
      systemPrompt: "P",
      idleTimeoutSeconds: 600,
      maxTurnDurationSeconds: 3600,
    }),
  );
  assert.equal(input.idleTimeoutSeconds, 600);
  assert.equal(input.maxTurnDurationSeconds, 3600);

  // 0 forwards as 0 — the >0 filter lives in Rust, so clear survives the hop.
  const cleared = createInputFromCommand(
    parsedCreate({
      name: "N",
      systemPrompt: "P",
      idleTimeoutSeconds: 0,
      maxTurnDurationSeconds: 0,
    }),
  );
  assert.equal(cleared.idleTimeoutSeconds, 0);
  assert.equal(cleared.maxTurnDurationSeconds, 0);

  // Absent stays absent.
  const absent = createInputFromCommand(
    parsedCreate({ name: "N", systemPrompt: "P" }),
  );
  assert.equal("idleTimeoutSeconds" in absent, false);
  assert.equal("maxTurnDurationSeconds" in absent, false);
});

test("update_input_forwards_all_phase2_fields", () => {
  const input = updateInputFromCommand(
    parsedUpdate({
      pubkey: PK,
      avatarUrl: "",
      idleTimeoutSeconds: 0,
      maxTurnDurationSeconds: 3600,
      startOnAppLaunch: false,
      envVarsPatch: { BUZZ_AGENT_THINKING_EFFORT: "high", OLD: null },
    }),
  );
  // Hardcoded expected input — the full forwarding surface in one shape.
  assert.deepEqual(input, {
    pubkey: PK,
    avatarUrl: "",
    idleTimeoutSeconds: 0,
    maxTurnDurationSeconds: 3600,
    startOnAppLaunch: false,
    envVarsPatch: { BUZZ_AGENT_THINKING_EFFORT: "high", OLD: null },
  });

  // Absent Phase-2 fields send nothing — absent means "don't touch".
  const minimal = updateInputFromCommand(parsedUpdate({ pubkey: PK }));
  assert.deepEqual(minimal, { pubkey: PK });

  // A non-empty avatar rides too (set, not just clear).
  const set = updateInputFromCommand(
    parsedUpdate({ pubkey: PK, avatarUrl: "https://x/y.png" }),
  );
  assert.equal(set.avatarUrl, "https://x/y.png");
});

test("update_input_still_forwards_the_phase1_fields", () => {
  const input = updateInputFromCommand(
    parsedUpdate({
      pubkey: PK,
      name: "N",
      systemPrompt: "P",
      model: "m",
      provider: "p",
      envVars: { K: "v" },
      parallelism: 3,
      respondTo: "allowlist",
      respondToAllowlist: ["cc".repeat(32)],
    }),
  );
  assert.deepEqual(input, {
    pubkey: PK,
    name: "N",
    systemPrompt: "P",
    model: "m",
    provider: "p",
    envVars: { K: "v" },
    parallelism: 3,
    respondTo: "allowlist",
    respondToAllowlist: ["cc".repeat(32)],
  });
});

test("restart_maps_to_stop_then_start", () => {
  const calls = lifecycleCallsFromCommand({ action: "restart", pubkey: PK });
  assert.deepEqual(calls, [
    { op: "stop", pubkey: PK },
    { op: "start", pubkey: PK },
  ]);
  // Single-action shapes stay single.
  assert.deepEqual(lifecycleCallsFromCommand({ action: "start", pubkey: PK }), [
    { op: "start", pubkey: PK },
  ]);
  assert.deepEqual(lifecycleCallsFromCommand({ action: "stop", pubkey: PK }), [
    { op: "stop", pubkey: PK },
  ]);
});

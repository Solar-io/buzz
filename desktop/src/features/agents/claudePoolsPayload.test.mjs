import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudePoolsPayload,
  effectivePool,
  poolEligibility,
} from "./claudePoolsPayload.ts";
import { parseOwnerAdminCommand } from "./ownerAdminProtocol.ts";

const CONFIG = {
  version: 1,
  default: "A",
  pools: {
    A: { label: "Main", configDir: null },
    B: { label: "Two", configDir: "~/cc2" },
  },
  assign: { " gilfoyle ": "B", Ghost: "Z" },
  overflow: { enabled: true, cooldownMinutes: 60 },
};

test("effectivePool: case-insensitive assign, unknown pool falls back to default", () => {
  assert.equal(effectivePool(CONFIG, "Gilfoyle"), "B");
  assert.equal(effectivePool(CONFIG, "Ghost"), "A");
  assert.equal(effectivePool(CONFIG, "Nobody"), "A");
  assert.equal(effectivePool(null, "Gilfoyle"), null);
  assert.equal(effectivePool({ ...CONFIG, default: "Q" }, "Gilfoyle"), null);
});

test("poolEligibility: claude adapter only, custom auth env excluded", () => {
  const base = { pubkey: "a", name: "x", envVars: {} };
  assert.deepEqual(
    poolEligibility({ ...base, agentCommand: "/opt/bin/claude-agent-acp" }),
    { eligible: true, reason: null },
  );
  assert.deepEqual(
    poolEligibility({
      ...base,
      agentCommand: "/Users/s/claude-glm/claude-glm-acp",
    }),
    { eligible: false, reason: "non-claude" },
  );
  assert.deepEqual(
    poolEligibility({
      ...base,
      agentCommand: "claude-agent-acp",
      envVars: { ANTHROPIC_BASE_URL: "http://x" },
    }),
    { eligible: false, reason: "custom-auth" },
  );
});

test("buildClaudePoolsPayload is deterministic and sorted", () => {
  const input = {
    hash: "h",
    parseError: null,
    config: CONFIG,
    agents: [
      {
        pubkey: "BB",
        name: "Zed",
        agentCommand: "claude-agent-acp",
        envVars: {},
      },
      {
        pubkey: "aa",
        name: "Gilfoyle",
        agentCommand: "claude-agent-acp",
        envVars: {},
      },
    ],
    accounts: {
      B: {
        loggedIn: true,
        email: "b@x",
        orgName: null,
        subscriptionType: "max",
        error: null,
        authMethod: "x",
      },
    },
  };
  const out = buildClaudePoolsPayload(input);
  assert.deepEqual(
    out.agents.map((a) => [a.name, a.pubkey, a.pool]),
    [
      ["Gilfoyle", "aa", "B"],
      ["Zed", "bb", "A"],
    ],
  );
  // authMethod is not carried (identity subset only).
  assert.equal("authMethod" in out.accounts.B, false);
  assert.equal(
    JSON.stringify(out),
    JSON.stringify(buildClaudePoolsPayload(input)),
  );
});

test("parseOwnerAdminCommand accepts set_claude_pools and requires baseHash", () => {
  const envelope = {
    type: "agent_admin_command",
    action: "set_claude_pools",
    requestId: "r1",
    request: { config: CONFIG, baseHash: "abc" },
  };
  const parsed = parseOwnerAdminCommand(envelope);
  assert.equal(parsed?.action, "set_claude_pools");
  assert.equal(parsed.baseHash, "abc");
  assert.equal(parsed.config.pools.B.configDir, "~/cc2");
  assert.equal(
    parseOwnerAdminCommand({ ...envelope, request: { config: CONFIG } }),
    null,
  );
  assert.equal(
    parseOwnerAdminCommand({
      ...envelope,
      request: {
        config: { ...CONFIG, pools: { A: { configDir: 5 } } },
        baseHash: "",
      },
    }),
    null,
  );
});

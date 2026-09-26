import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminCommand } from "./adminCommands.ts";
import { nextPoolsConfig, parseClaudePoolsPayload } from "./claudePools.ts";
import { desktopCatalogFromEvent } from "./desktopCatalog.ts";

const CONFIG = {
  version: 1,
  default: "A",
  pools: {
    A: { label: "Main", configDir: null },
    B: { label: "Two", configDir: "~/cc2" },
  },
  assign: { Gilfoyle: "B", "Other Machine Agent": "B" },
  overflow: { enabled: true, cooldownMinutes: 60 },
};

test("parseAdminCommand: set_claude_pools round-trips and requires baseHash", () => {
  const envelope = {
    type: "agent_admin_command",
    action: "set_claude_pools",
    requestId: "r",
    issuedAt: "2026-09-25T00:00:00Z",
    request: { config: CONFIG, baseHash: "h1" },
  };
  const parsed = parseAdminCommand(envelope);
  assert.equal(parsed?.command.action, "set_claude_pools");
  assert.equal(parsed.command.request.baseHash, "h1");
  assert.equal(parsed.command.request.config.pools.B.configDir, "~/cc2");
  assert.equal(
    parseAdminCommand({ ...envelope, request: { config: CONFIG } }),
    null,
  );
  assert.equal(
    parseAdminCommand({
      ...envelope,
      request: { config: { ...CONFIG, default: 7 }, baseHash: "h" },
    }),
    null,
  );
});

test("nextPoolsConfig: default-pool agents drop out of assign, foreign names kept", () => {
  const next = nextPoolsConfig(CONFIG, {
    defaultPool: "A",
    pools: CONFIG.pools,
    agentPools: { gilfoyle: "A", Nikon: "B" },
  });
  assert.deepEqual(next.assign, { "Other Machine Agent": "B", Nikon: "B" });
  assert.equal(next.default, "A");
});

test("parseClaudePoolsPayload: shape + format gate", () => {
  const payload = parseClaudePoolsPayload({
    format: "buzz-claude-pools",
    hash: "h",
    parseError: null,
    config: CONFIG,
    agents: [
      {
        pubkey: "aa",
        name: "Gilfoyle",
        pool: "B",
        eligible: true,
        reason: null,
      },
      {
        pubkey: "bb",
        name: "Evie",
        pool: "A",
        eligible: false,
        reason: "custom-auth",
      },
    ],
    accounts: { B: { loggedIn: true, email: "b@x", subscriptionType: "max" } },
  });
  assert.equal(payload?.agents.length, 2);
  assert.equal(payload.agents[1].reason, "custom-auth");
  assert.equal(payload.accounts.B.email, "b@x");
  assert.equal(parseClaudePoolsPayload({ format: "other", hash: "h" }), null);
});

test("desktopCatalogFromEvent keeps the sealed block opaque", () => {
  const event = {
    kind: 30180,
    tags: [["d", "crichton.local"]],
    content: JSON.stringify({
      format: "buzz-desktop-catalog",
      version: 3,
      machine: "crichton.local",
      harnesses: [],
      agents: [],
      updated_at: 5,
      claude_pools_sealed: "AqCipher==",
    }),
  };
  const catalog = desktopCatalogFromEvent(event);
  assert.equal(catalog?.version, 3);
  assert.equal(catalog.claudePoolsSealed, "AqCipher==");
});

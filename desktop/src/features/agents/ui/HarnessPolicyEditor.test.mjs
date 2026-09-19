import assert from "node:assert/strict";
import test from "node:test";

import { __harnessPolicyTestExports } from "./HarnessPolicyEditor.tsx";

const { clearOverride, routeFor, updateRole } = __harnessPolicyTestExports;

function policy() {
  return {
    schemaVersion: 1,
    revision: 0,
    delegation: {
      defaultMode: "proportional",
      explicitRequestRequiresPipeline: true,
    },
    roleDefaults: {
      coder: { model: "gpt-5.6-sol", effort: "low" },
      architect: { model: "gpt-5.6-sol", effort: "high" },
    },
    profiles: {
      codex: {
        enabled: true,
        adapter: "native",
        nativeConfigPath: null,
        nativeConfigFormat: null,
      },
    },
    agentOverrides: {},
  };
}

test("global role route is used when an agent has no override", () => {
  const result = routeFor(policy(), "coder", "a".repeat(64));
  assert.equal(result.override, undefined);
  assert.deepEqual(result.route, { model: "gpt-5.6-sol", effort: "low" });
});

test("agent override wins without changing global role default", () => {
  const pubkey = "a".repeat(64);
  const next = updateRole(
    policy(),
    "coder",
    {
      model: "gpt-5.6-sol",
      effort: "high",
    },
    pubkey,
  );
  assert.equal(next.agentOverrides[pubkey].coder.effort, "high");
  assert.equal(next.roleDefaults.coder.effort, "low");
});

test("clearing an override restores inheritance and removes empty agent state", () => {
  const pubkey = "a".repeat(64);
  const withOverride = updateRole(
    policy(),
    "coder",
    {
      model: "gpt-5.6-sol",
      effort: "high",
    },
    pubkey,
  );
  const cleared = clearOverride(withOverride, "coder", pubkey);
  assert.deepEqual(cleared.agentOverrides, {});
  assert.equal(routeFor(cleared, "coder", pubkey).route.effort, "low");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDesktopCatalogContent,
  catalogAvailability,
  catalogClaimedAgents,
  DESKTOP_CATALOG_KIND,
} from "./desktopCatalogContent.ts";

const AGENT_A = "aa".repeat(32);
const AGENT_B = "bb".repeat(32);

test("buildDesktopCatalogContent produces the pinned wire shape", () => {
  const content = buildDesktopCatalogContent({
    machine: "Crichton.Local ",
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        source: "preset",
        availability: "not-installed",
      },
      {
        id: "claude-code-glm",
        label: "Claude Code GLM",
        source: "custom",
        availability: "available",
      },
      {
        id: "builtin-agent",
        label: "Buzz Agent",
        source: "builtin",
        availability: "available",
      },
    ],
    agentPubkeys: [AGENT_B, AGENT_A, AGENT_B, "NOT-HEX"],
    updatedAt: 1788300000,
  });
  // Hardcoded expected body — the contract, not a echo of the input order.
  // version 2 = the Phase-2 capability signal (avatar/timeout/start-on-launch
  // edits, envVarsPatch, restart); the web gates its controls on >= 2.
  // version 3 = the set_claude_pools capability (Claude pool editor).
  assert.deepEqual(content, {
    format: "buzz-desktop-catalog",
    version: 5,
    caps: ["ping", "ack.result", "requires", "fresh"],
    machine: "crichton.local",
    harnesses: [
      {
        id: "claude-code-glm",
        label: "Claude Code GLM",
        source: "custom",
        availability: "available",
      },
      {
        id: "claude",
        label: "Claude Code",
        source: "preset",
        availability: "not-installed",
      },
      {
        id: "builtin-agent",
        label: "Buzz Agent",
        source: "builtin",
        availability: "available",
      },
    ],
    agents: [AGENT_A, AGENT_B],
    updated_at: 1788300000,
  });
  assert.equal(DESKTOP_CATALOG_KIND, 30180);
});

test("catalogAvailability maps every desktop availability onto the wire set", () => {
  assert.equal(catalogAvailability("available"), "available");
  assert.equal(catalogAvailability("adapter_missing"), "adapter-missing");
  assert.equal(catalogAvailability("adapter_outdated"), "adapter-missing");
  assert.equal(catalogAvailability("cli_missing"), "not-installed");
  assert.equal(catalogAvailability("not_installed"), "not-installed");
});

test("the serialized catalog never carries commands, args, env, or paths", () => {
  const content = buildDesktopCatalogContent({
    machine: "crichton.local",
    harnesses: [
      {
        id: "claude-code-glm",
        label: "Claude Code GLM",
        source: "custom",
        availability: "available",
      },
    ],
    agentPubkeys: [AGENT_A],
    updatedAt: 1788300000,
  });
  const serialized = JSON.stringify(content);
  for (const forbidden of [
    '"command"',
    '"args"',
    '"env"',
    '"binaryPath"',
    '"defaultArgs"',
    '"installInstructionsUrl"',
    "Users/",
    "/usr/local",
    ".json",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `catalog content must not contain ${forbidden}`,
    );
  }
});

test("claude pools: only an already-sealed string is carried, never plaintext", () => {
  const without = buildDesktopCatalogContent({
    machine: "crichton.local",
    harnesses: [],
    agentPubkeys: [AGENT_A],
    updatedAt: 1,
  });
  assert.equal("claude_pools_sealed" in without, false);
  const sealed = buildDesktopCatalogContent({
    machine: "crichton.local",
    harnesses: [],
    agentPubkeys: [AGENT_A],
    updatedAt: 1,
    claudePoolsSealed: "AqCiphertextBase64==",
  });
  assert.equal(sealed.claude_pools_sealed, "AqCiphertextBase64==");
  // The builder has no plaintext input to leak: no pools/assign keys exist.
  const serialized = JSON.stringify(sealed);
  for (const forbidden of ['"pools"', '"assign"', '"configDir"', "cc2", "@"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("deterministic: identical input serializes to identical bytes", () => {
  const input = {
    machine: "aeryn.local",
    harnesses: [
      {
        id: "codex",
        label: "Codex",
        source: "preset",
        availability: "available",
      },
    ],
    agentPubkeys: [AGENT_A],
    updatedAt: 1788300000,
  };
  assert.equal(
    JSON.stringify(buildDesktopCatalogContent(input)),
    JSON.stringify(buildDesktopCatalogContent(input)),
  );
  // updated_at is the only field that may differ between builds of the same
  // machine state — the publisher hash-compares the body without it.
  const a = buildDesktopCatalogContent({ ...input, updatedAt: 1 });
  const b = buildDesktopCatalogContent({ ...input, updatedAt: 2 });
  delete a.updated_at;
  delete b.updated_at;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("v4 claims every keyed managed agent, whatever its relay pin", () => {
  // Live shape 2026-09-26: most records carry an EMPTY relay_url, three are
  // pinned. v3 filtered on the pin and claimed only the three.
  const agents = [
    { pubkey: "aa".repeat(32), relayUrl: "" },
    { pubkey: "bb".repeat(32), relayUrl: "wss://relay.example:6351" },
    { pubkey: "cc".repeat(32), relayUrl: "ws://some-other-relay" },
    { pubkey: "", relayUrl: "" },
    { pubkey: "   ", relayUrl: "" },
  ];
  assert.deepEqual(
    catalogClaimedAgents(agents).map((agent) => agent.pubkey),
    ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)],
  );
});

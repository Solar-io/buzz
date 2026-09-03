import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDesktopCatalogContent,
  catalogAvailability,
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
  assert.deepEqual(content, {
    format: "buzz-desktop-catalog",
    version: 2,
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

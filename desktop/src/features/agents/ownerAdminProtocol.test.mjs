import assert from "node:assert/strict";
import test from "node:test";

import {
  commandTargetsThisMachine,
  parseOwnerAdminCommand,
} from "./ownerAdminProtocol.ts";

const PK = "ab".repeat(32);

function envelope(action, request, overrides = {}) {
  return {
    type: "agent_admin_command",
    action,
    requestId: "r1",
    request,
    ...overrides,
  };
}

test("parseOwnerAdminCommand: target present is surfaced on the command", () => {
  const parsed = parseOwnerAdminCommand(
    envelope(
      "create",
      { name: "x", systemPrompt: "y" },
      { target: "crichton.local" },
    ),
  );
  assert.equal(parsed.target, "crichton.local");
  assert.equal(parsed.action, "create");
});

test("parseOwnerAdminCommand: absent target stays undefined (legacy broadcast)", () => {
  const parsed = parseOwnerAdminCommand(envelope("start", { pubkey: PK }));
  assert.equal(parsed.target, undefined);
  assert.ok(!("target" in parsed));
});

test("parseOwnerAdminCommand: non-string target is dropped, command still parses", () => {
  const parsed = parseOwnerAdminCommand(
    envelope("update", { pubkey: PK, model: "m" }, { target: 42 }),
  );
  assert.equal(parsed.target, undefined);
  assert.equal(parsed.action, "update");
  assert.equal(parsed.model, "m");
});

test("parseOwnerAdminCommand rejects wrong type, missing fields, bad pubkeys, unknown action", () => {
  assert.equal(parseOwnerAdminCommand(null), null);
  assert.equal(
    parseOwnerAdminCommand({ type: "other", requestId: "r1" }),
    null,
  );
  assert.equal(parseOwnerAdminCommand(envelope("create", { name: "x" })), null);
  assert.equal(
    parseOwnerAdminCommand(envelope("delete", { pubkey: "zz" })),
    null,
  );
  assert.equal(
    parseOwnerAdminCommand(envelope("explode", { pubkey: PK })),
    null,
  );
});

test("parseOwnerAdminCommand parses each action's payload narrowly", () => {
  const create = parseOwnerAdminCommand(
    envelope("create", {
      name: "Test",
      systemPrompt: "You test.",
      harness: { kind: "custom", command: "claude", args: ["--x"] },
      envVars: { KEY: "v" },
    }),
  );
  assert.deepEqual(create.harness, {
    kind: "custom",
    command: "claude",
    args: ["--x"],
  });
  assert.equal(create.respondTo, "owner-only");

  const update = parseOwnerAdminCommand(
    envelope("update", { pubkey: PK, startOnAppLaunch: true }),
  );
  assert.equal(update.startOnAppLaunch, true);

  const del = parseOwnerAdminCommand(
    envelope("delete", { pubkey: PK, forceRemoteDelete: true }),
  );
  assert.equal(del.forceRemoteDelete, true);

  const stop = parseOwnerAdminCommand(envelope("stop", { pubkey: PK }));
  assert.equal(stop.action, "stop");
  assert.equal(stop.pubkey, PK);
});

test("parseOwnerAdminCommand drops a malformed harness rather than rejecting the command", () => {
  const parsed = parseOwnerAdminCommand(
    envelope("create", {
      name: "x",
      systemPrompt: "y",
      harness: { kind: "custom", command: 7 },
    }),
  );
  assert.equal(parsed.harness, undefined);
});

test("commandTargetsThisMachine: legacy broadcast applies; targeted only on match; unknown hostname fails closed", () => {
  // Legacy (no target): every machine applies.
  assert.equal(commandTargetsThisMachine({}, "crichton.local"), true);
  assert.equal(commandTargetsThisMachine({}, ""), true);
  // Exact match (case/whitespace normalized) applies.
  assert.equal(
    commandTargetsThisMachine({ target: "Crichton.Local " }, "crichton.local"),
    true,
  );
  // Another machine's command is not ours.
  assert.equal(
    commandTargetsThisMachine({ target: "aeryn.local" }, "crichton.local"),
    false,
  );
  // Hostname lookup failed → fail closed on targeted commands.
  assert.equal(
    commandTargetsThisMachine({ target: "crichton.local" }, ""),
    false,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  harnessFromSelection,
  parseAdminAck,
  parseAdminCommand,
} from "./adminCommands.ts";

const PK = "ab".repeat(32);

function envelope(action, request, overrides = {}) {
  return {
    type: "agent_admin_command",
    action,
    requestId: "r1",
    issuedAt: "2026-09-01T17:00:00Z",
    request,
    ...overrides,
  };
}

test("parseAdminCommand accepts a create with custom harness", () => {
  const parsed = parseAdminCommand(
    envelope("create", {
      name: "Test",
      systemPrompt: "You test.",
      model: "glm-5.3",
      harness: { kind: "custom", command: "claude", args: ["--x"] },
      envVars: { KEY: "v" },
    }),
  );
  assert.equal(parsed.command.action, "create");
  assert.deepEqual(parsed.command.request.harness, {
    kind: "custom",
    command: "claude",
    args: ["--x"],
  });
  assert.equal(parsed.command.request.respondTo, "owner-only");
});

test("parseAdminCommand accepts update/delete/start/stop by pubkey", () => {
  const upd = parseAdminCommand(
    envelope("update", { pubkey: PK, model: "m2" }),
  );
  assert.equal(upd.command.request.pubkey, PK);
  assert.equal(upd.command.request.model, "m2");
  const del = parseAdminCommand(
    envelope("delete", { pubkey: PK, forceRemoteDelete: true }),
  );
  assert.equal(del.command.request.forceRemoteDelete, true);
  const start = parseAdminCommand(envelope("start", { pubkey: PK }));
  assert.equal(start.command.action, "start");
  const stop = parseAdminCommand(envelope("stop", { pubkey: PK }));
  assert.equal(stop.command.action, "stop");
});

test("parseAdminCommand rejects wrong type, missing fields, bad pubkeys, unknown action", () => {
  assert.equal(parseAdminCommand(null), null);
  assert.equal(parseAdminCommand({ type: "other" }), null);
  assert.equal(parseAdminCommand(envelope("create", { name: "x" })), null);
  assert.equal(parseAdminCommand(envelope("delete", { pubkey: "zz" })), null);
  assert.equal(parseAdminCommand(envelope("explode", { pubkey: PK })), null);
  assert.equal(
    parseAdminCommand(
      envelope("create", { name: "x", systemPrompt: "y" }, { issuedAt: 5 }),
    ),
    null,
  );
});

test("parseAdminCommand drops a malformed harness rather than rejecting the command", () => {
  const parsed = parseAdminCommand(
    envelope("create", {
      name: "x",
      systemPrompt: "y",
      harness: { kind: "custom", command: 7 },
    }),
  );
  assert.equal(parsed.command.request.harness, undefined);
});

test("parseAdminCommand surfaces an envelope target for machine targeting", () => {
  const parsed = parseAdminCommand(
    envelope(
      "create",
      { name: "x", systemPrompt: "y" },
      { target: "crichton.local" },
    ),
  );
  assert.equal(parsed.target, "crichton.local");
  assert.equal(parsed.command.action, "create");
});

test("parseAdminCommand: absent target stays undefined (legacy broadcast)", () => {
  const parsed = parseAdminCommand(envelope("start", { pubkey: PK }));
  assert.equal(parsed.target, undefined);
  assert.ok(!("target" in parsed));
});

test("parseAdminCommand: non-string target is dropped, command still parses", () => {
  const parsed = parseAdminCommand(
    envelope("create", { name: "x", systemPrompt: "y" }, { target: 5 }),
  );
  assert.equal(parsed.target, undefined);
  assert.equal(parsed.command.action, "create");
});

test("parseAdminAck round shape + rejects", () => {
  const ack = parseAdminAck({
    type: "agent_admin_ack",
    requestId: "r1",
    ok: true,
    agentPubkey: PK,
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.agentPubkey, PK);
  assert.equal(
    parseAdminAck({ type: "agent_admin_ack", requestId: "r1" }),
    null,
  );
  assert.equal(
    parseAdminAck({
      type: "agent_admin_ack",
      requestId: "r1",
      ok: true,
      agentPubkey: "nope",
    }).agentPubkey,
    undefined,
  );
});

test("harnessFromSelection: preset wins, custom splits args, empty is null", () => {
  assert.deepEqual(harnessFromSelection("claude-code", "x", ""), {
    kind: "preset",
    runtimeId: "claude-code",
  });
  assert.deepEqual(
    harnessFromSelection(null, "bun run seat.ts", "  --a  --b "),
    {
      kind: "custom",
      command: "bun run seat.ts",
      args: ["--a", "--b"],
    },
  );
  assert.equal(harnessFromSelection(null, "   ", ""), null);
});

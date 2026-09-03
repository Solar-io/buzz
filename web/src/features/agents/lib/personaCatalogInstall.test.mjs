import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalogCreate } from "./personaCatalogInstall.ts";

/**
 * The catalog install builder, pinned with full deep-equals (extra wire keys
 * fail the suite, not just missing ones).
 *
 * NAMED MUTATION (tester): in personaCatalogInstall.ts change
 * `respondTo: "owner-only"` to `respondTo: publication.agent.respondTo ?? "owner-only"`
 * then `respondTo is forced to owner-only even when the publication says anyone`
 * must FAIL. Revert.
 */

const OWNER =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function publication(overrides = {}, agentOverrides = {}) {
  return {
    eventId: "e1",
    ownerPubkey: OWNER,
    sourcePersonaId: "night-shift",
    createdAt: 1_700_000_000,
    agent: {
      displayName: "Night Shift",
      avatarUrl: null,
      systemPrompt: "You work nights.",
      runtime: null,
      model: null,
      provider: null,
      namePool: [],
      respondTo: null,
      parallelism: null,
      ...agentOverrides,
    },
    ...overrides,
  };
}

function catalog(overrides = {}) {
  return {
    machine: "crichton.local",
    version: 2,
    harnesses: [{ id: "claude", label: "Claude Code", source: "builtin", availability: "available" }],
    agents: [],
    updatedAt: 1,
    ...overrides,
  };
}

test("minimal publication maps to the exact minimal create payload", () => {
  const built = buildCatalogCreate(publication(), [catalog()]);
  if (!("command" in built)) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command, {
    action: "create",
    request: {
      name: "Night Shift",
      systemPrompt: "You work nights.",
      respondTo: "owner-only",
      spawnAfterCreate: false,
      startOnAppLaunch: false,
    },
  });
  // One desktop → silent target.
  assert.equal(built.target, "crichton.local");
  assert.deepEqual(built.notes, []);
});

test("full publication maps every carried field", () => {
  const built = buildCatalogCreate(
    publication(
      {},
      {
        avatarUrl: "https://relay.example/a.png",
        runtime: "claude",
        model: "glm-5.3",
        provider: "zai",
        parallelism: 4,
        respondTo: "owner-only",
      },
    ),
    [catalog()],
  );
  if (!("command" in built)) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command, {
    action: "create",
    request: {
      name: "Night Shift",
      systemPrompt: "You work nights.",
      avatarUrl: "https://relay.example/a.png",
      model: "glm-5.3",
      provider: "zai",
      harness: { kind: "preset", runtimeId: "claude" },
      parallelism: 4,
      respondTo: "owner-only",
      spawnAfterCreate: false,
      startOnAppLaunch: false,
    },
  });
  assert.deepEqual(built.notes, []);
});

test("respondTo is forced to owner-only even when the publication says anyone", () => {
  const built = buildCatalogCreate(
    publication({}, { respondTo: "anyone" }),
    [catalog()],
  );
  if (!("command" in built)) {
    assert.fail(built.error);
  }
  assert.equal(built.command.request.respondTo, "owner-only");
  assert.deepEqual(built.notes, [
    "The publisher allows anyone to use this agent. Your copy starts owner-only — change who can use it after installing.",
  ]);
});

test("runtime without a catalog harness match omits harness, with the note", () => {
  const built = buildCatalogCreate(
    publication({}, { runtime: "foreign-runtime" }),
    [catalog()],
  );
  if (!("command" in built)) {
    assert.fail(built.error);
  }
  assert.equal(built.command.request.harness, undefined);
  assert.deepEqual(built.notes, [
    'The publisher\'s runtime ("foreign-runtime") is not a harness on your desktops — the desktop default harness applies.',
  ]);
});

test("data-URL avatar is omitted with the default-avatar note", () => {
  const built = buildCatalogCreate(
    publication({}, { avatarUrl: "data:image/png;base64,QUJD" }),
    [catalog()],
  );
  if (!("command" in built)) {
    assert.fail(built.error);
  }
  assert.equal(built.command.request.avatarUrl, undefined);
  assert.deepEqual(built.notes, [
    "The publication's inline avatar cannot be carried by an install — the new agent starts with the default avatar.",
  ]);
});

test("blank prompt is an error — never an instructions-less agent", () => {
  assert.deepEqual(
    buildCatalogCreate(publication({}, { systemPrompt: "" }), [catalog()]),
    {
      error:
        "This publication has no agent instructions, so there is nothing to install.",
    },
  );
  assert.deepEqual(
    buildCatalogCreate(publication({}, { systemPrompt: "   " }), [catalog()]),
    {
      error:
        "This publication has no agent instructions, so there is nothing to install.",
    },
  );
});

test("blank model/provider stay absent; whitespace model is dropped", () => {
  const built = buildCatalogCreate(
    publication({}, { model: "  ", provider: "" }),
    [catalog()],
  );
  if (!("command" in built)) {
    assert.fail(built.error);
  }
  assert.equal(built.command.request.model, undefined);
  assert.equal(built.command.request.provider, undefined);
});

test("two desktops → broadcast (no target)", () => {
  const built = buildCatalogCreate(publication(), [
    catalog(),
    catalog({ machine: "aeryn.local", updatedAt: 2 }),
  ]);
  if (!("command" in built)) {
    assert.fail(built.error);
  }
  assert.equal(built.target, undefined);
});

test("zero desktops still builds (the panel gates the button, not the builder)", () => {
  const built = buildCatalogCreate(publication(), []);
  assert.ok("command" in built);
  assert.equal(built.target, undefined);
});

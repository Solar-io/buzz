import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSnapshotCreate } from "./snapshotCreateRequest.ts";

/**
 * The honesty guard and the config-only mapping, pinned with full deep-equals
 * (extra wire keys fail the suite, not just missing ones).
 */

function view(overrides = {}, definitionOverrides = {}, profileOverrides = {}) {
  return {
    definition: {
      name: "Night Shift",
      sourceIsBuiltin: false,
      systemPrompt: "You work nights.",
      runtime: "claude",
      model: "glm-5.3",
      provider: "zai",
      parallelism: 4,
      respondTo: "owner-only",
      respondToAllowlist: [],
      namePool: [],
      idleTimeoutSeconds: 30,
      maxTurnDurationSeconds: 600,
      ...definitionOverrides,
    },
    displayName: "Night Shift",
    about: null,
    avatarDataUrl: null,
    avatarUrl: "https://relay.example/media/avatar.png",
    memoryLevel: "none",
    memoryEntryCount: 0,
    manifestJson: "{}",
    ...profileOverrides,
    ...overrides,
  };
}

test("config-only snapshot maps to the exact create payload", () => {
  const built = buildSnapshotCreate(view(), ["crichton.local"], ["claude"]);
  if (!("command" in built)) {
    assert.fail(built.unavailable ?? built.error);
  }
  assert.deepEqual(built.command, {
    action: "create",
    request: {
      name: "Night Shift",
      systemPrompt: "You work nights.",
      avatarUrl: "https://relay.example/media/avatar.png",
      model: "glm-5.3",
      provider: "zai",
      harness: { kind: "preset", runtimeId: "claude" },
      parallelism: 4,
      idleTimeoutSeconds: 30,
      maxTurnDurationSeconds: 600,
      respondTo: "owner-only",
      spawnAfterCreate: false,
      startOnAppLaunch: false,
    },
  });
  // One desktop → silent target (Phase-1 targetForAgent policy).
  assert.equal(built.target, "crichton.local");
  assert.deepEqual(built.notes, []);
});

test("memory-bearing snapshot is unavailable, with the desktop pointer", () => {
  const built = buildSnapshotCreate(
    view({ memoryLevel: "core", memoryEntryCount: 2 }),
    ["crichton.local"],
  );
  assert.deepEqual(built, {
    unavailable:
      "This snapshot includes 2 memory entries. Import in the Buzz desktop app to include memory.",
  });
  assert.equal("command" in built, false);
});

test("single memory entry wording is singular", () => {
  const built = buildSnapshotCreate(
    view({ memoryLevel: "core", memoryEntryCount: 1 }),
    [],
  );
  assert.match(built.unavailable, /1 memory entry\./);
});

test("name-pool-bearing snapshot is unavailable even without memory", () => {
  const built = buildSnapshotCreate(view({}, { namePool: ["Alice", "Bob"] }), [
    "crichton.local",
  ]);
  assert.deepEqual(built, {
    unavailable:
      "This snapshot includes a name pool. Import in the Buzz desktop app to include it.",
  });
});

test("prompt-less snapshot is unavailable — never an empty-prompt agent", () => {
  const built = buildSnapshotCreate(view({}, { systemPrompt: null }), [
    "crichton.local",
  ]);
  assert.deepEqual(built, {
    unavailable:
      "This snapshot has no system prompt. Import in the Buzz desktop app.",
  });
});

test("respondTo is forced owner-only; foreign allowlist becomes a note", () => {
  const built = buildSnapshotCreate(
    view({}, { respondTo: "allowlist", respondToAllowlist: ["aa".repeat(32)] }),
    [],
    ["claude"],
  );
  if (!("command" in built)) {
    assert.fail(built.unavailable ?? built.error);
  }
  assert.equal(built.command.request.respondTo, "owner-only");
  assert.equal("respondToAllowlist" in built.command.request, false);
  assert.deepEqual(built.notes, [
    "Web import always starts owner-only — the source allowlist (1 entry) is not copied.",
  ]);
  // Multiple desktops (or none) → broadcast, no target key.
  assert.equal("target" in built, false);
});

test("blank optionals stay absent; parallelism/timeouts ride only when > 0", () => {
  const built = buildSnapshotCreate(
    view(
      {},
      {
        model: "  ",
        provider: "",
        parallelism: 0,
        idleTimeoutSeconds: 0,
        maxTurnDurationSeconds: null,
        runtime: null,
      },
      { avatarUrl: "" },
    ),
    ["crichton.local"],
  );
  if (!("command" in built)) {
    assert.fail(built.unavailable ?? built.error);
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
  assert.deepEqual(built.notes, []);
});

test("data-URL avatar is skipped; hosted http avatar rides", () => {
  const dataUrl = buildSnapshotCreate(
    view(
      { avatarDataUrl: "data:image/png;base64,AAAA", avatarUrl: null },
      {},
      {},
    ),
    ["crichton.local"],
    ["claude"],
  );
  if (!("command" in dataUrl)) {
    assert.fail(dataUrl.unavailable ?? dataUrl.error);
  }
  assert.equal("avatarUrl" in dataUrl.command.request, false);
  assert.deepEqual(dataUrl.notes, [
    "The inline avatar cannot be carried by a web import — the new agent starts with the default avatar.",
  ]);
});

test("runtime without a catalog harness match omits harness and notes it", () => {
  const built = buildSnapshotCreate(
    view({}, { runtime: "goose" }),
    ["crichton.local"],
    ["claude", "codex"],
  );
  if (!("command" in built)) {
    assert.fail(built.unavailable ?? built.error);
  }
  assert.equal("harness" in built.command.request, false);
  assert.deepEqual(built.notes, [
    'The snapshot\'s runtime ("goose") is not a harness on your desktops — the desktop default harness applies.',
  ]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreateCommand } from "./createAgentRequest.ts";

function form(overrides = {}) {
  return {
    name: "Night Shift",
    systemPrompt: "You work nights.",
    avatarUrl: "",
    model: "",
    provider: "",
    parallelism: "",
    respondTo: "owner-only",
    respondToAllowlist: [],
    harnessId: "",
    customCommand: "",
    customArgs: "",
    envRows: [],
    startOnAppLaunch: true,
    ...overrides,
  };
}

function row(id, key, value) {
  return { id, key, value };
}

test("minimal form sends exactly the required shape — no field leakage", () => {
  const built = buildCreateCommand(form());
  if ("error" in built) {
    assert.fail(built.error);
  }
  // Full deep-equal: catches any accidental extra key riding the wire.
  assert.deepEqual(built.command, {
    action: "create",
    request: {
      name: "Night Shift",
      systemPrompt: "You work nights.",
      respondTo: "owner-only",
      spawnAfterCreate: true,
      startOnAppLaunch: true,
    },
  });
});

test("full form sends every optional that was set, trimmed", () => {
  const built = buildCreateCommand(
    form({
      avatarUrl: " https://example.com/a.png ",
      model: " glm-5.3 ",
      provider: " zai ",
      parallelism: " 3 ",
      harnessId: "claude",
      envRows: [row("r1", "MY_TOKEN", "x"), row("r2", "OTHER", "y")],
      respondTo: "anyone",
    }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command.request, {
    name: "Night Shift",
    systemPrompt: "You work nights.",
    avatarUrl: "https://example.com/a.png",
    model: "glm-5.3",
    provider: "zai",
    harness: { kind: "preset", runtimeId: "claude" },
    envVars: { MY_TOKEN: "x", OTHER: "y" },
    parallelism: 3,
    respondTo: "anyone",
    spawnAfterCreate: true,
    startOnAppLaunch: true,
  });
});

test("custom harness sends command + split args; blank args vanish", () => {
  const built = buildCreateCommand(
    form({
      harnessId: "__custom",
      customCommand: " bun run seat.ts ",
      customArgs: " --a   --b ",
    }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command.request.harness, {
    kind: "custom",
    command: "bun run seat.ts",
    args: ["--a", "--b"],
  });
});

test("allowlist mode sends the trimmed key list", () => {
  const key = "ab".repeat(32);
  const built = buildCreateCommand(
    form({
      respondTo: "allowlist",
      respondToAllowlist: [`  ${key}  `],
    }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command.request.respondToAllowlist, [key]);
});

test("startOnAppLaunch unchecked sends false (applied on create)", () => {
  const built = buildCreateCommand(form({ startOnAppLaunch: false }));
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.equal(built.command.request.startOnAppLaunch, false);
});

test("blank name and blank prompt are errors", () => {
  assert.equal(buildCreateCommand(form({ name: "   " })).error, "A name is required.");
  assert.equal(
    buildCreateCommand(form({ systemPrompt: "" })).error,
    "A system prompt is required.",
  );
});

test("custom harness without a command is an error", () => {
  const built = buildCreateCommand(
    form({ harnessId: "__custom", customCommand: "   " }),
  );
  assert.equal("error" in built && built.error, "A custom harness needs a command.");
});

test("reserved env key is an error naming the key", () => {
  const built = buildCreateCommand(
    form({ envRows: [row("r1", "buzz_private_key", "nope")] }),
  );
  assert.equal(
    "error" in built && built.error,
    "BUZZ_PRIVATE_KEY is set by Buzz and can't be overridden.",
  );
});

test("allowlist mode with an empty list is an error", () => {
  const built = buildCreateCommand(form({ respondTo: "allowlist" }));
  assert.equal(
    "error" in built && built.error,
    "Specific people requires at least one key.",
  );
});

test("parallelism: blank omits the key, invalid values error, valid sends a number", () => {
  const blank = buildCreateCommand(form());
  if ("error" in blank) {
    assert.fail(blank.error);
  }
  assert.equal("parallelism" in blank.command.request, false);

  assert.equal(
    buildCreateCommand(form({ parallelism: "zero" })).error,
    "Parallelism must be a whole number of 1 or more.",
  );
  assert.equal(
    buildCreateCommand(form({ parallelism: "0" })).error,
    "Parallelism must be a whole number of 1 or more.",
  );

  const valid = buildCreateCommand(form({ parallelism: "4" }));
  if ("error" in valid) {
    assert.fail(valid.error);
  }
  assert.equal(valid.command.request.parallelism, 4);
});

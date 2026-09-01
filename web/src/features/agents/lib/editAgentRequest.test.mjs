import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUpdateCommand,
  prefillEditForm,
  parseEnvText,
} from "./editAgentRequest.ts";

const PK = "ab".repeat(32);

function entry(overrides = {}) {
  return {
    pubkey: PK,
    name: "Night Shift",
    systemPrompt: "You work nights.",
    model: "glm-5.3",
    provider: "zai",
    personaId: null,
    parallelism: 3,
    respondTo: "owner-only",
    respondToAllowlist: ["cd".repeat(32)],
    updatedAt: 1000,
    ...overrides,
  };
}

function value(prefill, overrides = {}) {
  return { ...prefill, ...overrides };
}

test("prefillEditForm fills from the entry; definition-linked entries fill from the persona", () => {
  const prefill = prefillEditForm(entry(), null);
  assert.equal(prefill.name, "Night Shift");
  assert.equal(prefill.systemPrompt, "You work nights.");
  assert.equal(prefill.model, "glm-5.3");
  assert.equal(prefill.provider, "zai");
  assert.equal(prefill.parallelism, "3");
  assert.equal(prefill.respondTo, "owner-only");
  assert.equal(prefill.respondToAllowlist, "cd".repeat(32));
  assert.equal(prefill.harnessId, "__keep");
  assert.equal(prefill.envText, "");
  assert.equal(prefill.startOnAppLaunch, "keep");
  assert.equal(prefill.personaLinked, false);

  // Slimmed 30177 (definition-linked): quad comes from the 30175 definition.
  const linked = prefillEditForm(
    entry({
      personaId: "persona-1",
      systemPrompt: "",
      model: "",
      provider: "",
    }),
    {
      id: "persona-1",
      name: "Night Shift (definition)",
      systemPrompt: "From the definition.",
      model: "glm-5.3",
      provider: "zai",
      runtime: "claude-code-glm",
      updatedAt: 900,
    },
  );
  assert.equal(linked.personaLinked, true);
  assert.equal(linked.systemPrompt, "From the definition.");
  assert.equal(linked.name, "Night Shift (definition)");
});

test("unchanged fields are absent from the update request", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(base, prefill, value(prefill));
  assert.equal("error" in built, true);
  assert.equal(built.error, "Nothing changed.");
});

test("only the changed field is sent", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { model: "glm-5.4" }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.equal(built.command.action, "update");
  assert.deepEqual(built.command.request, {
    pubkey: PK,
    model: "glm-5.4",
  });
});

test('harness "keep current" sends no harness key; a picked harness sends one', () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const keep = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { model: "glm-5.4" }),
  );
  if ("error" in keep) {
    assert.fail(keep.error);
  }
  assert.equal("harness" in keep.command.request, false);

  const picked = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { harnessId: "claude-code-glm" }),
  );
  if ("error" in picked) {
    assert.fail(picked.error);
  }
  assert.deepEqual(picked.command.request.harness, {
    kind: "preset",
    runtimeId: "claude-code-glm",
  });

  const custom = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      harnessId: "__custom",
      customCommand: "bun run seat.ts",
      customArgs: " --a --b ",
    }),
  );
  if ("error" in custom) {
    assert.fail(custom.error);
  }
  assert.deepEqual(custom.command.request.harness, {
    kind: "custom",
    command: "bun run seat.ts",
    args: ["--a", "--b"],
  });

  const badCustom = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { harnessId: "__custom", customCommand: "  " }),
  );
  assert.equal(
    "error" in badCustom && badCustom.error.includes("command"),
    true,
  );
});

test("blank env sends no envVars; filled env replaces wholesale", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const blank = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { model: "glm-5.4" }),
  );
  if ("error" in blank) {
    assert.fail(blank.error);
  }
  assert.equal("envVars" in blank.command.request, false);

  const filled = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { envText: "KEY=value\nOTHER=2" }),
  );
  if ("error" in filled) {
    assert.fail(filled.error);
  }
  assert.deepEqual(filled.command.request.envVars, {
    KEY: "value",
    OTHER: "2",
  });

  const malformed = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { envText: "NOEQUALS" }),
  );
  assert.equal("error" in malformed, true);
});

test("startOnAppLaunch keep sends nothing; on/off send the boolean", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const keep = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { model: "glm-5.4" }),
  );
  if ("error" in keep) {
    assert.fail(keep.error);
  }
  assert.equal("startOnAppLaunch" in keep.command.request, false);

  const on = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { startOnAppLaunch: "on" }),
  );
  if ("error" in on) {
    assert.fail(on.error);
  }
  assert.equal(on.command.request.startOnAppLaunch, true);

  const off = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { startOnAppLaunch: "off" }),
  );
  if ("error" in off) {
    assert.fail(off.error);
  }
  assert.equal(off.command.request.startOnAppLaunch, false);
});

test("allowlist edit validates hex and parallelism must be a positive int", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const badList = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { respondToAllowlist: "not-hex" }),
  );
  assert.equal("error" in badList, true);

  const goodList = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { respondToAllowlist: `  ${"ee".repeat(32)}  \n` }),
  );
  if ("error" in goodList) {
    assert.fail(goodList.error);
  }
  assert.deepEqual(goodList.command.request.respondToAllowlist, [
    "ee".repeat(32),
  ]);

  const badParallelism = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { parallelism: "zero" }),
  );
  assert.equal(
    "error" in badParallelism && badParallelism.error,
    "Nothing changed.",
  );

  const goodParallelism = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { parallelism: "5" }),
  );
  if ("error" in goodParallelism) {
    assert.fail(goodParallelism.error);
  }
  assert.equal(goodParallelism.command.request.parallelism, 5);
});

test("parseEnvText: empty is {}, malformed line reports the line", () => {
  assert.deepEqual(parseEnvText("   "), { envVars: {} });
  assert.deepEqual(parseEnvText("A=1\nB=two words"), {
    envVars: { A: "1", B: "two words" },
  });
  const bad = parseEnvText("A=1\nBAD");
  assert.equal("error" in bad && bad.error.includes("BAD"), true);
});

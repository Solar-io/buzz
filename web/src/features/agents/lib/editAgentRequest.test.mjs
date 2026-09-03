import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUpdateCommand, prefillEditForm } from "./editAgentRequest.ts";

const PK = "ab".repeat(32);
const KEY_A = "cd".repeat(32);
const KEY_B = "ee".repeat(32);

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
    respondToAllowlist: [KEY_A],
    updatedAt: 1000,
    ...overrides,
  };
}

function persona(overrides = {}) {
  return {
    id: "persona-1",
    name: "Night Shift (definition)",
    systemPrompt: "From the definition.",
    model: "glm-5.3",
    provider: "zai",
    runtime: "claude-code-glm",
    updatedAt: 900,
    ...overrides,
  };
}

function value(prefill, overrides = {}) {
  return { ...prefill, ...overrides };
}

function row(id, key, val) {
  return { id, key, value: val };
}

test("prefillEditForm fills from the entry; linked entries fill from the persona", () => {
  const prefill = prefillEditForm(entry(), null);
  assert.equal(prefill.name, "Night Shift");
  assert.equal(prefill.systemPrompt, "You work nights.");
  assert.equal(prefill.model, "glm-5.3");
  assert.equal(prefill.provider, "zai");
  assert.equal(prefill.parallelism, "3");
  assert.equal(prefill.respondTo, "owner-only");
  assert.deepEqual(prefill.respondToAllowlist, [KEY_A]);
  assert.equal(prefill.harnessId, "__keep");
  assert.deepEqual(prefill.envRows, []);
  assert.equal(prefill.envDirty, false);
  assert.equal(prefill.personaLinked, false);

  // Slimmed 30177 (definition-linked): quad comes from the 30175 definition.
  const linked = prefillEditForm(
    entry({
      personaId: "persona-1",
      systemPrompt: "",
      model: "",
      provider: "",
    }),
    persona(),
  );
  assert.equal(linked.personaLinked, true);
  assert.equal(linked.systemPrompt, "From the definition.");
  assert.equal(linked.name, "Night Shift (definition)");
  assert.equal(linked.model, "glm-5.3");
  assert.equal(linked.provider, "zai");
});

test("prefill is a copy, not an alias, of the entry's allowlist", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  prefill.respondToAllowlist.push("mutant");
  assert.deepEqual(base.respondToAllowlist, [KEY_A]);
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

test("blank model sends no model key (blank-means-keep is load-bearing)", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { name: "Renamed", model: "" }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.equal("model" in built.command.request, false);
  assert.deepEqual(built.command.request, { pubkey: PK, name: "Renamed" });
});

test('harness "keep current" sends no harness key; picked and custom send theirs', () => {
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

test("clean env table sends no envVars key even when rows are present", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      name: "Renamed",
      envRows: [row("r1", "SOME_KEY", "present-but-clean")],
      envDirty: false,
    }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.equal("envVars" in built.command.request, false);
  assert.deepEqual(built.command.request, { pubkey: PK, name: "Renamed" });
});

test("dirty env table sends the FULL record (replace semantics)", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      envRows: [
        row("r1", "BUZZ_AGENT_PROVIDER", "zai"),
        row("r2", "", "mid-edit"),
      ],
      envDirty: true,
    }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command.request.envVars, {
    BUZZ_AGENT_PROVIDER: "zai",
  });
});

test("dirty env table with zero valid rows explicitly clears all env", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { envRows: [], envDirty: true }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command.request.envVars, {});
});

test("reserved env key in a dirty table is an error naming the key", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      envRows: [row("r1", "buzz_private_key", "nope")],
      envDirty: true,
    }),
  );
  assert.equal(
    "error" in built && built.error,
    "BUZZ_PRIVATE_KEY is set by Buzz and can't be overridden.",
  );
});

test("linked entry refuses quad edits with the definition error", () => {
  const base = entry({ personaId: "persona-1", model: "", provider: "" });
  const prefill = prefillEditForm(base, persona());
  const promptEdit = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { systemPrompt: "owner tries to change it" }),
  );
  assert.match(
    "error" in promptEdit ? promptEdit.error : "",
    /comes from its definition/,
  );
  const modelEdit = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { model: "glm-5.4" }),
  );
  assert.equal("error" in modelEdit, true);
  // Linked entries still accept everything the desktop applies for them:
  const nameEdit = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { name: "Renamed" }),
  );
  if ("error" in nameEdit) {
    assert.fail(nameEdit.error);
  }
  assert.equal(nameEdit.command.request.name, "Renamed");
});

test("allowlist edits validate hex; mode switch to allowlist needs a key", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const badList = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { respondToAllowlist: ["not-hex"] }),
  );
  assert.equal("error" in badList, true);

  const goodList = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { respondToAllowlist: [KEY_B] }),
  );
  if ("error" in goodList) {
    assert.fail(goodList.error);
  }
  assert.deepEqual(goodList.command.request.respondToAllowlist, [KEY_B]);

  const emptySwitch = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { respondTo: "allowlist", respondToAllowlist: [] }),
  );
  assert.equal(
    "error" in emptySwitch && emptySwitch.error,
    "Specific people requires at least one key.",
  );

  // Switching to allowlist keeps the prefilled (unchanged) list — that is a
  // real key, so it sends.
  const keepSwitch = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { respondTo: "allowlist" }),
  );
  if ("error" in keepSwitch) {
    assert.fail(keepSwitch.error);
  }
  assert.equal(keepSwitch.command.request.respondTo, "allowlist");

  const anyone = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { respondTo: "anyone" }),
  );
  if ("error" in anyone) {
    assert.fail(anyone.error);
  }
  assert.deepEqual(anyone.command.request, { pubkey: PK, respondTo: "anyone" });
});

test("parallelism: blank keeps, invalid errors, changed sends a number", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const blank = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { parallelism: "" }),
  );
  assert.equal("error" in blank && blank.error, "Nothing changed.");

  assert.equal(
    buildUpdateCommand(base, prefill, value(prefill, { parallelism: "zero" }))
      .error,
    "Parallelism must be a whole number of 1 or more.",
  );
  assert.equal(
    buildUpdateCommand(base, prefill, value(prefill, { parallelism: "0" }))
      .error,
    "Parallelism must be a whole number of 1 or more.",
  );

  const good = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { parallelism: "5" }),
  );
  if ("error" in good) {
    assert.fail(good.error);
  }
  assert.equal(good.command.request.parallelism, 5);
});

// ── Phase 2: avatar, timeouts, start-on-launch, effort ──────────────────────

const AVATAR = "https://img.example/x.png";

function prefillWithAvatar() {
  return prefillEditForm(entry(), null, AVATAR);
}

test("avatar: unchanged absent, changed sends the URL, cleared sends the empty-string sentinel", () => {
  const base = entry();

  const unchanged = buildUpdateCommand(
    base,
    prefillWithAvatar(),
    value(prefillWithAvatar(), { name: "Renamed" }),
  );
  if ("error" in unchanged) {
    assert.fail(unchanged.error);
  }
  assert.equal("avatarUrl" in unchanged.command.request, false);

  const changed = buildUpdateCommand(
    base,
    prefillWithAvatar(),
    value(prefillWithAvatar(), { avatarUrl: "https://img.example/y.png" }),
  );
  if ("error" in changed) {
    assert.fail(changed.error);
  }
  assert.deepEqual(changed.command.request, {
    pubkey: PK,
    avatarUrl: "https://img.example/y.png",
  });

  const cleared = buildUpdateCommand(
    base,
    prefillWithAvatar(),
    value(prefillWithAvatar(), { avatarUrl: "" }),
  );
  if ("error" in cleared) {
    assert.fail(cleared.error);
  }
  assert.deepEqual(cleared.command.request, {
    pubkey: PK,
    avatarUrl: "",
  });
});

test("timeouts: blank absent, 0 clears, positive sets, garbage errors", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);

  const set = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      idleTimeoutSeconds: "600",
      maxTurnDurationSeconds: "3600",
    }),
  );
  if ("error" in set) {
    assert.fail(set.error);
  }
  assert.equal(set.command.request.idleTimeoutSeconds, 600);
  assert.equal(set.command.request.maxTurnDurationSeconds, 3600);

  const clear = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { idleTimeoutSeconds: "0" }),
  );
  if ("error" in clear) {
    assert.fail(clear.error);
  }
  assert.deepEqual(clear.command.request, {
    pubkey: PK,
    idleTimeoutSeconds: 0,
  });

  for (const bad of ["abc", "-5", "1.5", "12s"]) {
    const invalid = buildUpdateCommand(
      base,
      prefill,
      value(prefill, { maxTurnDurationSeconds: bad }),
    );
    assert.equal("error" in invalid, true, `${bad} must be an error`);
  }
});

test("startOnAppLaunch: keep absent, on/off send booleans", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const on = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { startOnAppLaunch: "on" }),
  );
  if ("error" in on) {
    assert.fail(on.error);
  }
  assert.deepEqual(on.command.request, { pubkey: PK, startOnAppLaunch: true });

  const off = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { startOnAppLaunch: "off" }),
  );
  if ("error" in off) {
    assert.fail(off.error);
  }
  assert.deepEqual(off.command.request, {
    pubkey: PK,
    startOnAppLaunch: false,
  });
});

test("effort alone rides envVarsPatch only — never an envVars key", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { effort: "high" }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command.request, {
    pubkey: PK,
    envVarsPatch: { BUZZ_AGENT_THINKING_EFFORT: "high" },
  });
  assert.equal("envVars" in built.command.request, false);

  const cleared = buildUpdateCommand(
    base,
    prefill,
    value(prefill, { effort: "clear" }),
  );
  if ("error" in cleared) {
    assert.fail(cleared.error);
  }
  assert.deepEqual(cleared.command.request, {
    pubkey: PK,
    envVarsPatch: { BUZZ_AGENT_THINKING_EFFORT: null },
  });
});

test("effort plus a dirty env table folds into ONE envVars replace", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      effort: "high",
      envRows: [row("r1", "OTHER_KEY", "v")],
      envDirty: true,
    }),
  );
  if ("error" in built) {
    assert.fail(built.error);
  }
  assert.deepEqual(built.command.request.envVars, {
    OTHER_KEY: "v",
    BUZZ_AGENT_THINKING_EFFORT: "high",
  });
  assert.equal("envVarsPatch" in built.command.request, false);

  // The fold wins over a table row holding the same key (newer intent).
  const conflict = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      effort: "high",
      envRows: [row("r1", "BUZZ_AGENT_THINKING_EFFORT", "low")],
      envDirty: true,
    }),
  );
  if ("error" in conflict) {
    assert.fail(conflict.error);
  }
  assert.deepEqual(conflict.command.request.envVars, {
    BUZZ_AGENT_THINKING_EFFORT: "high",
  });
});

test("fold-clear colliding with the key in the table is a builder error", () => {
  const base = entry();
  const prefill = prefillEditForm(base, null);
  const built = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      effort: "clear",
      envRows: [row("r1", "BUZZ_AGENT_THINKING_EFFORT", "low")],
      envDirty: true,
    }),
  );
  assert.equal(
    "error" in built && built.error,
    "The environment table sets the same key the effort control would remove.",
  );

  // Clear + dirty table WITHOUT the key is fine: the replace simply omits it.
  const fine = buildUpdateCommand(
    base,
    prefill,
    value(prefill, {
      effort: "clear",
      envRows: [row("r1", "OTHER_KEY", "v")],
      envDirty: true,
    }),
  );
  if ("error" in fine) {
    assert.fail(fine.error);
  }
  assert.deepEqual(fine.command.request.envVars, { OTHER_KEY: "v" });
  assert.equal("envVarsPatch" in fine.command.request, false);
});

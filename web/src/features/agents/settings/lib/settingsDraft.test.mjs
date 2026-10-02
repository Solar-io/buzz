import assert from "node:assert/strict";
import { test } from "node:test";
import {
  editSettingsDraft,
  resetSettingsDraft,
  planSettingsCommands,
  settingsDraftSummary,
  settingsEffectSummary,
  undoSettingsDraft,
} from "./settingsDraft.ts";
import { saveSettingsCommands } from "./settingsSave.ts";

function entry(agentPubkey = "a", field = "model", overrides = {}) {
  return {
    agentPubkey,
    agentName: `Agent ${agentPubkey}`,
    machine: "crichton",
    field,
    label: field,
    original: { value: "old", inherited: false },
    clearValue: null,
    defaultLabel: "global",
    takesEffect: "restart-when-idle",
    change: { kind: "set", value: "new" },
    ...overrides,
  };
}

test('3 edits on 3 agents summarises "3 changes on 3 agents"', () => {
  let draft = new Map();
  for (const key of ["a", "b", "c"])
    draft = editSettingsDraft(draft, entry(key));
  assert.equal(draft.size, 3);
  assert.equal(settingsDraftSummary(draft), "3 changes on 3 agents");
  assert.equal(planSettingsCommands(draft).length, 3);
});
test("reset of a set value produces a clear, not an omission", () => {
  const draft = resetSettingsDraft(new Map(), entry());
  assert.equal(draft.size, 1);
  assert.deepEqual([...draft.values()][0].change, { kind: "clear" });
  assert.deepEqual(planSettingsCommands(draft)[0].request, {
    pubkey: "a",
    model: null,
  });
  const timeout = resetSettingsDraft(
    new Map(),
    entry("b", "idleTimeoutSeconds", { clearValue: 0 }),
  );
  assert.deepEqual(planSettingsCommands(timeout)[0].request, {
    pubkey: "b",
    idleTimeoutSeconds: 0,
  });
});
test("editing back to the original value is not dirty", () => {
  const draft = editSettingsDraft(new Map(), entry());
  assert.equal(
    editSettingsDraft(
      draft,
      entry("a", "model", { change: { kind: "set", value: "old" } }),
    ).size,
    0,
  );
  assert.equal(draft.size, 1, "the input map is immutable");
});
test("draft preserves its baseline through edits and inherited reset is clean", () => {
  const draft = editSettingsDraft(new Map(), entry());
  const changed = editSettingsDraft(
    draft,
    entry("a", "model", {
      original: { value: "new", inherited: false },
      change: { kind: "set", value: "old" },
    }),
  );
  assert.equal(changed.size, 0);
  assert.equal(
    resetSettingsDraft(
      new Map(),
      entry("a", "model", { original: { value: "old", inherited: true } }),
    ).size,
    0,
  );
  assert.equal(
    editSettingsDraft(
      new Map(),
      entry("a", "model", { original: { value: "new", inherited: true } }),
    ).size,
    1,
    "setting the default explicitly is still an override",
  );
});
test("per-agent plans combine fields and group when they apply", () => {
  let draft = editSettingsDraft(new Map(), entry());
  draft = editSettingsDraft(draft, entry("a", "provider"));
  draft = editSettingsDraft(
    draft,
    entry("b", "text", { takesEffect: "next-turn" }),
  );
  assert.equal(
    settingsEffectSummary(draft),
    "2 restart when idle · 1 next turn",
  );
  assert.deepEqual(
    planSettingsCommands(draft).map((plan) => plan.request),
    [
      { pubkey: "a", model: "new", provider: "new" },
      { pubkey: "b", text: "new" },
    ],
  );
});
test("undo restores a set baseline and clears an inherited baseline", () => {
  const changes = [
    entry(),
    entry("b", "model", { original: { value: "global", inherited: true } }),
  ];
  assert.deepEqual(
    planSettingsCommands(undoSettingsDraft(changes)).map(
      (plan) => plan.request,
    ),
    [
      { pubkey: "a", model: "old" },
      { pubkey: "b", model: null },
    ],
  );
});
test("plans reject target divergence and unsafe field names", () => {
  let draft = editSettingsDraft(new Map(), entry());
  draft = editSettingsDraft(
    draft,
    entry("a", "provider", { machine: "another-desktop" }),
  );
  assert.throws(() => planSettingsCommands(draft), /one desktop/);
  for (const field of ["pubkey", "__proto__", "constructor", "prototype"]) {
    assert.throws(
      () =>
        planSettingsCommands(editSettingsDraft(new Map(), entry("a", field))),
      /Invalid settings field/,
    );
  }
});
test("batch sends at concurrency three and preserves partial success receipts", async () => {
  let draft = new Map();
  for (const key of ["a", "b", "c", "d", "e"])
    draft = editSettingsDraft(draft, entry(key));
  let active = 0;
  let peak = 0;
  const calls = [];
  const results = await saveSettingsCommands(
    planSettingsCommands(draft),
    async (plan) => {
      active++;
      peak = Math.max(peak, active);
      calls.push(plan.request.pubkey);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return plan.request.pubkey === "b"
        ? { ok: false, error: 'unknown model "new"' }
        : { ok: true };
    },
  );
  assert.equal(peak, 3);
  assert.deepEqual(calls, ["a", "b", "c", "d", "e"]);
  assert.equal(results.filter((result) => result.ack.ok).length, 4);
  assert.equal(results[1].ack.error, 'unknown model "new"');
});
test("silent desktop times out honestly and a late ack cannot turn it into Saved", async () => {
  let answer;
  const results = await saveSettingsCommands(
    planSettingsCommands(editSettingsDraft(new Map(), entry())),
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    5,
  );
  assert.equal(results[0].timedOut, true);
  assert.equal(results[0].ack.ok, false);
  assert.equal(
    results[0].ack.error,
    "No answer from crichton — it may still apply. Check status after reload.",
  );
  answer({ ok: true });
  assert.equal(results[0].ack.ok, false);
});
test("synchronous and rejected send failures are receipts, never a batch rollback", async () => {
  const plans = planSettingsCommands(editSettingsDraft(new Map(), entry()));
  const results = await saveSettingsCommands(plans, () => {
    throw new Error("relay refused");
  });
  assert.deepEqual(results[0].ack, { ok: false, error: "relay refused" });
});

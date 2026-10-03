import assert from "node:assert/strict";
import { test, after } from "node:test";
import {
  dom,
  mount,
  selectFor,
  change,
  fields,
  row,
  act,
} from "./cardTestHelpers.mjs";
import { RuntimeCard } from "./RuntimeCard.tsx";
import {
  buildCardUpdate,
  SETTINGS_FIELDS,
  readTimeoutEcho,
  writeTimeoutEcho,
  settingBaseline,
} from "./agentSettingsFields.ts";
after(() => dom.window.close());
function plan(field, value, original = 1800) {
  return {
    machine: "crichton.local",
    action: "update",
    request: { pubkey: row.pubkey, [field]: value },
    entries: [
      {
        field,
        original: { value: original },
        change: value === 0 ? { kind: "clear" } : { kind: "set", value },
        clearValue: SETTINGS_FIELDS[field]?.[1] ?? null,
      },
    ],
  };
}
test("idle built-in renders 15 min — built in", async () => {
  await mount(RuntimeCard, { fields: fields(), catalogs: [] }, (container) => {
    const control = selectFor(container, "Idle timeout");
    assert.equal(control.value, "inherit");
    assert.match(control.textContent, /15 min — built in/);
    assert.match(
      selectFor(container, "Longest turn").textContent,
      /12 h — built in/,
    );
  });
});
test("Custom… 7 min sends idleTimeoutSeconds 420", async () => {
  let wire;
  await mount(
    RuntimeCard,
    {
      fields: fields({}, (field, next) => {
        wire = buildCardUpdate(plan(field, next), row, { kind: "keep" }, null);
      }),
      catalogs: [],
    },
    async (container) => {
      await change(
        selectFor(container, "Idle timeout"),
        "value:__custom_duration",
      );
      const input = container.querySelector(
        '[aria-label="Idle timeout custom amount"]',
      );
      await act(() => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        ).set.call(input, "7");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await act(() =>
        input
          .closest("form")
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      assert.deepEqual(wire, {
        command: {
          action: "update",
          request: { pubkey: row.pubkey, idleTimeoutSeconds: 420 },
        },
      });
    },
  );
});
test("reset sends 0 (clear sentinel)", async () => {
  let wire;
  await mount(
    RuntimeCard,
    {
      fields: fields({ idleTimeoutSeconds: 1800 }, (field, next) => {
        wire = buildCardUpdate(
          plan(field, next === null ? 0 : next),
          row,
          { kind: "keep" },
          null,
        );
      }),
      catalogs: [],
    },
    async (container) => {
      await act(() =>
        container
          .querySelector('[aria-label="Reset Idle timeout to default"]')
          .click(),
      );
      assert.equal(wire.command.request.idleTimeoutSeconds, 0);
    },
  );
});
test("unreported durations stay collapsed and never masquerade as current built-ins", async () => {
  await mount(
    RuntimeCard,
    {
      fields: fields({
        idleTimeoutSeconds: "__unreported",
        maxTurnDurationSeconds: "__unreported",
      }),
      catalogs: [],
    },
    (container) => {
      const control = selectFor(container, "Idle timeout");
      assert.equal(control.closest("details").open, false);
      assert.equal(control.value, "unreported");
      assert.match(control.parentElement.textContent, /Not reported/);
    },
  );
});
test("runtime inheritance is locked and Turns at once forwards a number", async () => {
  let picked;
  await mount(
    RuntimeCard,
    {
      fields: fields({}, (field, value) => {
        picked = [field, value];
      }),
      catalogs: [],
    },
    async (container) => {
      assert.equal(
        selectFor(container, "Runtime").querySelector('[value="inherit"]')
          .disabled,
        true,
      );
      await change(selectFor(container, "Turns at once"), "value:4");
      assert.deepEqual(picked, ["parallelism", 4]);
      assert.doesNotMatch(container.textContent, /Turn timeout/);
    },
  );
});
test("timeout echo whitelists only browser edits, rejects junk and round-trips reset", () => {
  let saved;
  writeTimeoutEcho(
    {
      setItem: (_key, value) => {
        saved = value;
      },
    },
    "scope",
    {
      idleTimeoutSeconds: 1800,
      maxTurnDurationSeconds: null,
      model: "secret",
      apiKey: "secret",
    },
  );
  assert.deepEqual(JSON.parse(saved), {
    idleTimeoutSeconds: 1800,
    maxTurnDurationSeconds: 0,
  });
  assert.deepEqual(readTimeoutEcho({ getItem: () => saved }, "scope"), {
    idleTimeoutSeconds: 1800,
    maxTurnDurationSeconds: null,
  });
  assert.deepEqual(
    readTimeoutEcho(
      {
        getItem: () =>
          '{"idleTimeoutSeconds":-1,"maxTurnDurationSeconds":1.5,"apiKey":"secret"}',
      },
      "scope",
    ),
    {},
  );
  assert.equal(settingBaseline(row, {}, "idleTimeoutSeconds"), "__unreported");
});
test("card builder sends API key in patch only and refuses later-phase writes", () => {
  const result = buildCardUpdate(
    plan("apiKey", "Set new key", "__unreported"),
    row,
    { kind: "set", value: " secret-value " },
    "OPENROUTER_API_KEY",
  );
  assert.deepEqual(result.command.request, {
    pubkey: row.pubkey,
    envVarsPatch: { OPENROUTER_API_KEY: "secret-value" },
  });
  assert.ok(
    buildCardUpdate(plan("respondTo", "nobody"), row, { kind: "keep" }, null)
      .error,
  );
  assert.ok(
    buildCardUpdate(plan("model", null), row, { kind: "keep" }, null).error,
  );
  assert.ok(
    buildCardUpdate(plan("effort", "low"), row, { kind: "keep" }, null).error,
  );
});

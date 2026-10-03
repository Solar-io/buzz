import assert from "node:assert/strict";
import { test, after } from "node:test";
import { dom, mount, fields, row, selectFor } from "./cardTestHelpers.mjs";
import { ModelThinkingCard } from "./ModelThinkingCard.tsx";
after(() => dom.window.close());
test("unreported Effort is hidden rather than presented as an inherited value", async () => {
  await mount(
    ModelThinkingCard,
    {
      row: { ...row, entry: { ...row.entry, effort: null } },
      models: [],
      apiKey: { kind: "keep" },
      onApiKey() {},
      fields: fields(),
    },
    (container) => {
      assert.equal(
        [...container.querySelectorAll("label")].some(
          (label) => label.textContent === "Effort",
        ),
        false,
      );
    },
  );
});
const props = {
  row,
  models: ["old-model"],
  apiKey: { kind: "keep" },
  onApiKey() {},
};
test("provider/key controls only appear for Buzz Agent and Goose; Effort stays locked", async () => {
  for (const runtime of ["buzz-agent", "goose", "claude", "__unreported"])
    await mount(
      ModelThinkingCard,
      {
        ...props,
        fields: fields({
          harness:
            runtime === "__unreported"
              ? runtime
              : JSON.stringify({ kind: "preset", runtimeId: runtime }),
        }),
      },
      (container) => {
        assert.equal(
          Boolean(
            container.querySelector('[data-testid="web-provider-api-key"]'),
          ),
          ["buzz-agent", "goose"].includes(runtime),
        );
        const effort = selectFor(container, "Effort");
        assert.equal(effort.disabled, true);
        assert.equal(effort.value, "value:medium");
        assert.match(effort.textContent, /medium/);
      },
    );
});
test("linked model is definition-owned; supplied models stay grouped", async () => {
  await mount(
    ModelThinkingCard,
    { ...props, row: { ...row, personaLinked: true }, fields: fields() },
    (container) => {
      assert.equal(selectFor(container, "Model").disabled, true);
      assert.match(container.textContent, /come from the definition/);
      assert.equal(
        container.querySelector("optgroup").label,
        "In use on your agents",
      );
    },
  );
});

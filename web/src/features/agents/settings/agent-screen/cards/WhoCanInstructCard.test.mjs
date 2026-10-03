import assert from "node:assert/strict";
import { test, after } from "node:test";
import {
  dom,
  mount,
  selectFor,
  change,
  fields,
  act,
} from "./cardTestHelpers.mjs";
import { WhoCanInstructCard } from "./WhoCanInstructCard.tsx";
after(() => dom.window.close());
test("warning renders after the people picker for allowlist and directly under the selector for anyone", async () => {
  for (const mode of ["allowlist", "anyone"])
    await mount(
      WhoCanInstructCard,
      {
        fields: fields({ respondTo: mode }),
        people: [{ pubkey: "b".repeat(64), name: "Sam" }],
      },
      (container) => {
        const warning = container.querySelector(
          '[data-testid="agent-access-warning"]',
        );
        const preceding =
          mode === "anyone"
            ? selectFor(container, "Who can instruct")
            : container.querySelector(
                '[data-testid="instruction-people-picker"]',
              );
        assert.equal(preceding.nextElementSibling, warning);
        assert.equal(
          warning.textContent,
          `${mode === "anyone" ? "Anyone" : "Selected people"} can use this agent to access your computer, including files, accounts, and connected tools.`,
        );
      },
    );
});
test("people picker shows names and writes keys; Nobody stays locked", async () => {
  let picked;
  await mount(
    WhoCanInstructCard,
    {
      fields: fields({ respondTo: "allowlist" }, (field, value) => {
        picked = [field, value];
      }),
      people: [{ pubkey: "b".repeat(64), name: "Sam" }],
    },
    async (container) => {
      assert.match(container.textContent, /Sam/);
      assert.doesNotMatch(container.textContent, /bbbbbbbb/);
      assert.equal(
        selectFor(container, "Who can instruct").querySelector(
          '[value="nobody"]',
        ).disabled,
        true,
      );
      await act(() =>
        container.querySelector('input[type="checkbox"]').click(),
      );
      assert.deepEqual(picked, [
        "respondToAllowlist",
        JSON.stringify(["b".repeat(64)]),
      ]);
      await change(selectFor(container, "Who can instruct"), "anyone");
      assert.deepEqual(picked, ["respondTo", "anyone"]);
    },
  );
});
test("Only me has no shared-access warning; offline prevents picker edits", async () => {
  await mount(
    WhoCanInstructCard,
    { fields: { ...fields(), disabled: true }, people: [] },
    (container) => {
      assert.equal(
        container.querySelector('[data-testid="agent-access-warning"]'),
        null,
      );
      assert.equal(selectFor(container, "Who can instruct").disabled, true);
    },
  );
});

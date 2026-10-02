import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://web.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SettingSelect } = await import("./SettingSelect.tsx");
const { ModelSelect } = await import("./ModelSelect.tsx");
const { DurationSelect } = await import("./DurationSelect.tsx");
const { SaveBar } = await import("./SaveBar.tsx");
after(() => dom.window.close());

test("duplicate display names keep both change receipts without duplicate React keys", async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await mount(
      SaveBar,
      {
        summary: "2 changes on 2 agents",
        changes: [
          { id: "a:model", text: "Agent Model old → new" },
          { id: "b:model", text: "Agent Model old → new" },
        ],
        effectSummary: "2 on restart",
        state: { status: "idle" },
        onSave() {},
        onDiscard() {},
      },
      async (container) => {
        assert.equal(container.querySelectorAll("li").length, 2);
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    console.error = original;
  }
});

async function mount(Component, props, run) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(h(Component, props)));
    await run(container);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}
async function select(container, value) {
  await act(() => {
    const control = container.querySelector("select");
    control.value = value;
    control.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
const base = {
  label: "Effort",
  value: null,
  defaultValue: "medium",
  source: "Defaults",
  takesEffect: "on restart",
  options: [{ value: "high", label: "high" }],
  onChange() {},
};

test("SettingSelect renders inherited, set and dirty states with default-first and reset", async () => {
  for (const [props, state, text] of [
    [base, "inherited", "Uses the default · from Defaults"],
    [{ ...base, value: "high" }, "set", "Set here · default is medium"],
    [
      { ...base, value: "high", dirty: true, originalLabel: "low" },
      "dirty",
      "was low",
    ],
  ])
    await mount(SettingSelect, props, async (container) => {
      assert.equal(container.firstChild.dataset.settingState, state);
      assert.ok(container.textContent.includes(text));
      assert.equal(
        container.querySelector("option").textContent,
        "Use default — medium · Defaults",
      );
      assert.equal(container.querySelector("select").disabled, false);
      assert.equal(
        container.querySelectorAll("button").length,
        state === "inherited" ? 0 : 1,
      );
      assert.ok(container.textContent.includes("on restart"));
    });
});
test("locked never fires onChange", async () => {
  const calls = [];
  await mount(
    SettingSelect,
    {
      ...base,
      locked: true,
      value: "high",
      onChange: (value) => calls.push(value),
    },
    async (container) => {
      assert.equal(container.querySelector("select").disabled, true);
      assert.ok(
        container.textContent.includes(
          "Update Buzz Desktop on crichton to change this",
        ),
      );
      await select(container, "inherit");
      await act(() => container.querySelector("button").click());
      assert.deepEqual(calls, []);
    },
  );
});
test("offline shows last published value and cannot select or reset", async () => {
  const calls = [];
  await mount(
    SettingSelect,
    {
      ...base,
      offline: true,
      value: "high",
      onChange: (value) => calls.push(value),
    },
    async (container) => {
      assert.equal(container.querySelector("select").value, "value:high");
      assert.ok(
        container.textContent.includes(
          "crichton is offline · Needs the desktop",
        ),
      );
      await select(container, "inherit");
      assert.deepEqual(calls, []);
    },
  );
});
test("setting emits a value and reset emits null instead of an omitted edit", async () => {
  const calls = [];
  await mount(
    SettingSelect,
    { ...base, value: "high", onChange: (value) => calls.push(value) },
    async (container) => {
      await select(container, "value:high");
      await act(() => container.querySelector("button").click());
      assert.deepEqual(calls, ["high", null]);
    },
  );
});
test("model picker groups supplied models and counts; Other submits a trimmed id", async () => {
  const calls = [];
  await mount(
    ModelSelect,
    {
      ...base,
      label: "Model",
      inUse: [{ value: "opus", label: "Opus", count: 2 }],
      discovered: [{ value: "sol", label: "Sol" }],
      mesh: [{ value: "mesh", label: "Mesh model" }],
      onChange: (value) => calls.push(value),
    },
    async (container) => {
      assert.deepEqual(
        [...container.querySelectorAll("optgroup")].map((group) => group.label),
        ["In use on your agents", "Runtime-discovered", "Mesh"],
      );
      assert.ok(container.textContent.includes("Opus · 2 agents"));
      await select(container, "value:__other_model");
      const input = container.querySelector(
        'input[aria-label="Other model id"]',
      );
      assert.ok(input);
      assert.equal(calls.length, 0);
      // Native setter simulates typing; React's value tracker must see the event.
      await act(() => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        ).set.call(input, " custom/model ");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await act(() =>
        container
          .querySelector("form")
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      assert.deepEqual(calls, ["custom/model"]);
    },
  );
});
test("duration presets show minutes/hours and custom hours send seconds", async () => {
  const calls = [];
  await mount(
    DurationSelect,
    {
      ...base,
      label: "Idle timeout",
      value: 900,
      defaultValue: 900,
      presets: [120, 900, 3600],
      onChange: (value) => calls.push(value),
    },
    async (container) => {
      assert.ok(container.textContent.includes("15 mins"));
      assert.ok(container.textContent.includes("1 hour"));
      await select(container, "value:3600");
      await select(container, "value:__custom_duration");
      await act(() => {
        const input = container.querySelector("input");
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        ).set.call(input, "2");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        const unit = container.querySelector(
          'select[aria-label="Idle timeout custom unit"]',
        );
        unit.value = "3600";
        unit.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      await act(() =>
        container
          .querySelector("form")
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      assert.deepEqual(calls, [3600, 7200]);
    },
  );
});
test("SaveBar waits for ack, renders Saved/Undo and quotes refused text safely", async () => {
  const props = {
    summary: "3 changes on 3 agents",
    changes: [{ id: "acid:model", text: "Acid Burn model old → new" }],
    effectSummary: "2 restart when idle · 1 next turn",
    onSave() {},
    onDiscard() {},
  };
  await mount(
    SaveBar,
    { ...props, state: { status: "sending", machines: ["crichton"] } },
    async (container) => {
      assert.ok(container.textContent.includes("Sending to crichton…"));
      assert.ok(!container.textContent.includes("Saved"));
      assert.ok(
        [...container.querySelectorAll("button")].every(
          (button) => button.disabled,
        ),
      );
    },
  );
  await mount(
    SaveBar,
    {
      ...props,
      state: { status: "saved", machines: ["crichton"], savedAt: 0 },
      onUndo() {},
    },
    async (container) => {
      assert.ok(container.textContent.includes("Saved on crichton"));
      assert.equal(container.querySelector("button").textContent, "Undo");
    },
  );
  await mount(
    SaveBar,
    {
      ...props,
      state: {
        status: "error",
        errors: [
          {
            id: "acid",
            machine: "crichton",
            error: '<img src=x onerror="attack()"> unknown model',
          },
        ],
      },
    },
    async (container) => {
      assert.ok(container.textContent.includes("crichton refused the change"));
      assert.ok(
        container.textContent.includes('<img src=x onerror="attack()">'),
      );
      assert.equal(container.querySelector("img"), null);
    },
  );
});

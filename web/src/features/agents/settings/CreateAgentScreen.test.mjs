import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dom, mount, fill, choose, button, act } from "./w11aTestSupport.mjs";
const { CreateAgentScreen } = await import("./CreateAgentScreen.tsx");
after(() => dom.window.close());

const catalog = {
  machine: "crichton.local",
  version: 4,
  updatedAt: 1,
  agents: [],
  harnesses: [
    {
      id: "buzz-agent",
      label: "Buzz Agent",
      source: "builtin",
      availability: "available",
    },
    {
      id: "codex",
      label: "Codex",
      source: "preset",
      availability: "available",
    },
  ],
};
function props(send) {
  return {
    admin: { send, pending: [], acks: new Map() },
    catalogs: [catalog],
    registryModels: ["opus"],
    onCreated() {},
    onCancel() {},
  };
}
async function identity(container) {
  await fill(container, "Name", "W11a throwaway");
  await fill(container, "System prompt", "Reply briefly.");
}
async function create(container) {
  await act(async () => button(container, "Create agent").click());
}

test("blank create sends create with name, prompt, runtime and the chosen idle timeout", async () => {
  const sent = [],
    created = [];
  const initial = props(async (...args) => {
    sent.push(args);
    return "request-1";
  });
  initial.onCreated = (key) => created.push(key);
  await mount(CreateAgentScreen, initial, async (container, render) => {
    await identity(container);
    await choose(container, "Runtime", "value:codex");
    await choose(container, "Idle timeout", "value:1800");
    await create(container);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0][0], {
      action: "create",
      request: {
        name: "W11a throwaway",
        systemPrompt: "Reply briefly.",
        harness: { kind: "preset", runtimeId: "codex" },
        parallelism: 10,
        idleTimeoutSeconds: 1800,
        maxTurnDurationSeconds: 43200,
        respondTo: "owner-only",
        spawnAfterCreate: true,
        startOnAppLaunch: true,
      },
    });
    assert.deepEqual(sent[0][2], { target: "crichton.local" });
    assert.deepEqual(
      created,
      [],
      "relay acceptance does not complete creation",
    );
    assert.ok(button(container, "Waiting for desktop…").disabled);
    const ack = {
      requestId: "request-1",
      ok: true,
      agentPubkey: "ab".repeat(32),
    };
    await render({
      ...initial,
      admin: { ...initial.admin, acks: new Map([["request-1", ack]]) },
    });
    assert.deepEqual(created, ["ab".repeat(32)]);
  });
});
test("blank create uses the built-in runtime and 15 minute / 12 hour defaults", async () => {
  let command;
  await mount(
    CreateAgentScreen,
    props(async (next) => {
      command = next;
      return null;
    }),
    async (container) => {
      await identity(container);
      await create(container);
      assert.equal(command.request.harness.runtimeId, "buzz-agent");
      assert.equal(command.request.idleTimeoutSeconds, 900);
      assert.equal(command.request.maxTurnDurationSeconds, 43200);
      assert.equal(command.request.parallelism, 10);
      assert.equal(command.request.model, undefined);
    },
  );
});
test("blank create locks unsupported timeouts and omits them for an old desktop", async () => {
  let command;
  const initial = props(async (next) => {
    command = next;
    return null;
  });
  initial.catalogs = [{ ...catalog, version: 1 }];
  await mount(CreateAgentScreen, initial, async (container) => {
    assert.match(container.textContent, /Update Buzz Desktop on crichton/);
    await identity(container);
    await create(container);
    assert.equal(command.request.idleTimeoutSeconds, undefined);
    assert.equal(command.request.maxTurnDurationSeconds, undefined);
  });
});
test("blank create targets the chosen desktop and gates its own runtime/timeouts", async () => {
  const sent = [];
  const initial = props(async (...args) => {
    sent.push(args);
    return null;
  });
  initial.catalogs = [
    catalog,
    { ...catalog, machine: "other", version: 1, harnesses: [] },
  ];
  await mount(CreateAgentScreen, initial, async (container) => {
    await identity(container);
    await choose(container, "Create on", "other");
    await create(container);
    assert.deepEqual(sent[0][2], { target: "other" });
    assert.equal(sent[0][0].request.idleTimeoutSeconds, undefined);
  });
});
test("blank create keeps the draft and quotes refusal before retry", async () => {
  let sends = 0;
  const initial = props(async () => `request-${++sends}`);
  await mount(CreateAgentScreen, initial, async (container, render) => {
    await identity(container);
    await create(container);
    const ack = { ok: false, error: "Runtime is not installed" };
    await render({
      ...initial,
      admin: { ...initial.admin, acks: new Map([["request-1", ack]]) },
    });
    assert.equal(
      container.querySelector('[role="alert"]').textContent,
      "Runtime is not installed",
    );
    assert.equal(
      container.querySelector('[aria-label="Name"]').value,
      "W11a throwaway",
    );
    await create(container);
    assert.equal(sends, 2);
  });
});
test("blank create reports a send failure and permits retry without waiting", async () => {
  await mount(
    CreateAgentScreen,
    props(async () => null),
    async (container) => {
      await identity(container);
      await create(container);
      assert.match(
        container.querySelector('[role="alert"]').textContent,
        /command was not sent/,
      );
      assert.equal(button(container, "Create agent").disabled, false);
    },
  );
});
test("blank create handles rejected sends without dropping instructions", async () => {
  await mount(
    CreateAgentScreen,
    props(async () => {
      throw new Error("Network unavailable");
    }),
    async (container) => {
      await identity(container);
      await create(container);
      assert.equal(
        container.querySelector('[role="alert"]').textContent,
        "Network unavailable",
      );
      assert.equal(
        container.querySelector('[aria-label="System prompt"]').value,
        "Reply briefly.",
      );
    },
  );
});
test("blank create shows 30 second uncertainty, prevents duplicates and accepts a late ack", async () => {
  const originalTimer = window.setTimeout,
    originalClear = window.clearTimeout;
  let timeout;
  window.setTimeout = (callback, delay) => {
    assert.equal(delay, 30000);
    timeout = callback;
    return 123;
  };
  window.clearTimeout = () => {};
  try {
    const created = [],
      initial = props(async () => "request-1");
    initial.onCreated = (key) => created.push(key);
    await mount(CreateAgentScreen, initial, async (container, render) => {
      await identity(container);
      await create(container);
      assert.equal(typeof timeout, "function");
      await act(() => timeout());
      assert.match(
        container.textContent,
        /No answer from crichton — it may still apply/,
      );
      assert.ok(button(container, "Waiting for desktop…").disabled);
      await render({
        ...initial,
        admin: {
          ...initial.admin,
          acks: new Map([["request-1", { ok: true, agentPubkey: "a" }]]),
        },
      });
      assert.deepEqual(created, ["a"]);
    });
  } finally {
    window.setTimeout = originalTimer;
    window.clearTimeout = originalClear;
  }
});
test("blank create requires an agent key on success and never offers duplicate creation", async () => {
  const initial = props(async () => "request-1");
  await mount(CreateAgentScreen, initial, async (container, render) => {
    await identity(container);
    await create(container);
    await render({
      ...initial,
      admin: { ...initial.admin, acks: new Map([["request-1", { ok: true }]]) },
    });
    assert.match(container.textContent, /without an agent key/);
    assert.ok(button(container, "Create agent").disabled);
  });
});
test("blank create supports a custom runtime and custom duration in wire seconds", async () => {
  let command;
  await mount(
    CreateAgentScreen,
    props(async (next) => {
      command = next;
      return null;
    }),
    async (container) => {
      await identity(container);
      await choose(container, "Runtime", "value:__custom");
      await fill(container, "Custom runtime command", "custom-agent");
      await fill(container, "Custom runtime arguments", "--one --two");
      await choose(container, "Idle timeout", "value:__custom_duration");
      await fill(container, "Idle timeout custom amount", "7");
      await act(() => button(container, "Use").click());
      await create(container);
      assert.deepEqual(command.request.harness, {
        kind: "custom",
        command: "custom-agent",
        args: ["--one", "--two"],
      });
      assert.equal(command.request.idleTimeoutSeconds, 420);
    },
  );
});

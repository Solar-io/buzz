import assert from "node:assert/strict";
import { test, after } from "node:test";
import { act, dom, mount, fields, row, h } from "./cardTestHelpers.mjs";
const React = await import("react");
globalThis.__BUZZ_TEST_REACT__ = React;
globalThis.__BUZZ_TEST_MODULE_STUBS__ = {
  "@tanstack/react-router": `export const Link = props => globalThis.__BUZZ_TEST_REACT__.createElement('a', {href: '/repos/settings?' + new URLSearchParams(props.search)}, props.children);`,
  "@/shared/ui/dialog": `const h=globalThis.__BUZZ_TEST_REACT__.createElement; export const Dialog=({open,children})=>open?h('div',{role:'dialog'},children):null; export const DialogContent=({children})=>h('div',null,children); export const DialogDescription=({children})=>h('p',null,children); export const DialogFooter=({children})=>h('div',null,children); export const DialogTitle=({children})=>h('h3',null,children);`,
  "@/shared/api/blossom": `export const uploadBlob = async file => globalThis.__W9B2_UPLOAD__(file);`,
  "@/features/channels/ui/AuthorAvatar": `export const AuthorAvatar=()=>null;`,
};
const { EnvVarsCard } = await import("./EnvVarsCard.tsx");
const { IdentityCard } = await import("./IdentityCard.tsx");
const { RemoveCard } = await import("./RemoveCard.tsx");
const { buildCardUpdate, SETTINGS_FIELDS, settingBaseline } = await import(
  "./agentSettingsFields.ts"
);
const { buildEnvPatch } = await import("./envPatch.ts");
const { planSettingsCommands } = await import("../../lib/settingsDraft.ts");
const { cardChangeText } = await import("./cardChangeText.ts");
after(() => dom.window.close());
function plan(field, value, original = "__unreported") {
  return planSettingsCommands(
    new Map([
      [
        field,
        {
          agentPubkey: row.pubkey,
          agentName: row.name,
          machine: "crichton.local",
          field,
          label: SETTINGS_FIELDS[field][0],
          original: { value: original, inherited: false },
          change: { kind: "set", value },
          clearValue: null,
          defaultLabel: "Desktop default",
          takesEffect: "on-restart",
        },
      ],
    ]),
  )[0];
}
const envRow = (key, value, operation = "set") => ({
  id: key,
  key,
  value,
  operation,
});
const build = (rows) =>
  buildCardUpdate(
    plan("envChanges", "Edit variables"),
    row,
    { kind: "keep" },
    null,
    rows,
  );
test("adding one row sends envVarsPatch {K:'v'} and never envVars", () => {
  assert.deepEqual(build([envRow("K", "v")]), {
    command: {
      action: "update",
      request: { pubkey: row.pubkey, envVarsPatch: { K: "v" } },
    },
  });
});
test("deleting sends {K:null} without clearing other variables", () => {
  assert.deepEqual(build([envRow("K", "", "remove")]).command.request, {
    pubkey: row.pubkey,
    envVarsPatch: { K: null },
  });
});
test("reserved, blank, invalid and duplicate keys refuse the environment patch", () => {
  assert.match(
    build([envRow(" buzz_private_key ", "x")]).error,
    /BUZZ_PRIVATE_KEY is set by Buzz/,
  );
  assert.match(build([envRow("", "x")]).error, /variable name/);
  assert.match(build([envRow("BAD=NAME", "x")]).error, /letters, numbers/);
  assert.match(
    buildEnvPatch([envRow("K", "1"), envRow("K", "2")]).error,
    /one row/,
  );
  assert.deepEqual(
    build([envRow("__proto__", "safe")]).command.request.envVarsPatch,
    JSON.parse('{"__proto__":"safe"}'),
  );
});
test("environment and API-key patches combine; conflicting edits refuse", () => {
  const entry = plan("envChanges", "Edit variables");
  const key = plan("apiKey", "Set new key");
  entry.entries = [...entry.entries, ...key.entries];
  entry.request.apiKey = "Set new key";
  const result = buildCardUpdate(
    entry,
    row,
    { kind: "set", value: "synthetic" },
    "OPENROUTER_API_KEY",
    [envRow("FOO", "bar")],
  );
  assert.deepEqual(result.command.request.envVarsPatch, {
    FOO: "bar",
    OPENROUTER_API_KEY: "synthetic",
  });
  assert.match(
    buildCardUpdate(
      entry,
      row,
      { kind: "set", value: "synthetic" },
      "OPENROUTER_API_KEY",
      [envRow("OPENROUTER_API_KEY", "other")],
    ).error,
    /Choose one/,
  );
});
test("blind environment controls are collapsed, masked, and remove only the named key", async () => {
  function Screen() {
    const [rows, setRows] = React.useState([envRow("FOO", "secret")]);
    return h(EnvVarsCard, { rows, onChange: setRows, disabled: false });
  }
  await mount(Screen, {}, async (container) => {
    assert.equal(container.querySelector("details").open, false);
    assert.equal(
      container.querySelector("input[type=password]").value,
      "secret",
    );
    const select = container.querySelector("select");
    await act(() => {
      select.value = "remove";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(container.querySelector("input[type=password]"), null);
    assert.match(container.textContent, /Removes only this named variable/);
  });
});
test("environment receipts never contain variable values", () => {
  assert.equal(
    cardChangeText(plan("envChanges", "marker").entries[0], []),
    "Test agent Environment variables changed",
  );
});
test("identity updates name, prompt and avatar through the existing command builder", () => {
  const named = buildCardUpdate(
    plan("name", "New name", "Test agent"),
    row,
    { kind: "keep" },
    null,
  );
  assert.deepEqual(named.command.request, {
    pubkey: row.pubkey,
    name: "New name",
  });
  assert.equal(
    buildCardUpdate(
      plan("systemPrompt", "New prompt", ""),
      row,
      { kind: "keep" },
      null,
    ).command.request.systemPrompt,
    "New prompt",
  );
  assert.equal(
    buildCardUpdate(
      plan("avatarUrl", "https://media.test/avatar.png", ""),
      row,
      { kind: "keep" },
      null,
    ).command.request.avatarUrl,
    "https://media.test/avatar.png",
  );
  assert.match(
    buildCardUpdate(
      plan("systemPrompt", "", "prior"),
      row,
      { kind: "keep" },
      null,
    ).error,
    /clear instructions/,
  );
  assert.equal(
    settingBaseline({ ...row, systemPrompt: "reported" }, {}, "systemPrompt"),
    "reported",
  );
});
test("linked identity opens the exact Library definition and hides standalone prompt", async () => {
  const linked = {
    ...row,
    personaLinked: true,
    entry: { ...row.entry, personaId: "definition-123" },
    persona: { name: "Linked definition" },
  };
  await mount(
    IdentityCard,
    { row: linked, fields: fields({ name: row.name, avatarUrl: "" }) },
    (container) => {
      assert.equal(container.querySelector("textarea"), null);
      assert.match(
        container.querySelector("a").href,
        /group=library&tab=definitions&definition=definition-123/,
      );
      assert.match(container.textContent, /Linked definition/);
    },
  );
});
test("avatar Change uploads and stages the server-validated image URL", async () => {
  let edit;
  globalThis.__W9B2_UPLOAD__ = async () => ({
    url: "https://media.test/avatar.png",
    mime_type: "image/png",
  });
  await mount(
    IdentityCard,
    {
      row,
      fields: fields(
        { name: row.name, avatarUrl: "", systemPrompt: "" },
        (field, value) => {
          edit = [field, value];
        },
      ),
    },
    async (container) => {
      const input = container.querySelector("input[type=file]");
      Object.defineProperty(input, "files", {
        value: [
          new dom.window.File(["x"], "avatar.png", { type: "image/png" }),
        ],
      });
      await act(async () => {
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      assert.deepEqual(edit, ["avatarUrl", "https://media.test/avatar.png"]);
    },
  );
});
test("Delete confirms the channel count and waits for desktop ack", async () => {
  const acks = new Map();
  let removed = 0;
  let wire;
  await mount(
    RemoveCard,
    {
      row,
      channelCount: 3,
      disabled: false,
      onRemoved: () => removed++,
      admin: {
        acks,
        send: async (command) => {
          wire = command;
          return "delete-id";
        },
      },
    },
    async (container) => {
      await act(() =>
        [...container.querySelectorAll("button")]
          .find((el) => el.textContent === "Delete…")
          .click(),
      );
      assert.match(
        container.querySelector("[role=dialog]").textContent,
        /3 channels/,
      );
      assert.equal(wire, undefined);
      await act(() =>
        [...container.querySelectorAll("button")]
          .find((el) => el.textContent === "Confirm delete")
          .click(),
      );
      assert.deepEqual(wire, {
        action: "delete",
        request: { pubkey: row.pubkey, forceRemoteDelete: true },
      });
      assert.equal(removed, 0);
      await act(async () => {
        acks.set("delete-id", { ok: true });
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      assert.equal(removed, 1);
    },
  );
});
test("Unregister keeps the key and a refused ack preserves the confirmation", async () => {
  let wire;
  let removed = 0;
  await mount(
    RemoveCard,
    {
      row,
      channelCount: 1,
      disabled: false,
      onRemoved: () => removed++,
      admin: {
        acks: new Map([["id", { ok: false, error: "Desktop refused" }]]),
        send: async (command) => {
          wire = command;
          return "id";
        },
      },
    },
    async (container) => {
      await act(() =>
        [...container.querySelectorAll("button")]
          .find((el) => el.textContent === "Unregister")
          .click(),
      );
      assert.match(
        container.querySelector("[role=dialog]").textContent,
        /key and settings stay/,
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((el) => el.textContent === "Confirm unregister")
          .click(),
      );
      assert.deepEqual(wire, {
        action: "unregister",
        request: { pubkey: row.pubkey },
      });
      assert.equal(removed, 0);
      assert.match(container.textContent, /Desktop refused/);
    },
  );
});

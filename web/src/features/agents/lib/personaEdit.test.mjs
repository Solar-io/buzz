import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentsSharingDefinition,
  buildPersonaUpdate,
  definitionEditable,
} from "./personaEdit.ts";

const BASE_CONTENT =
  '{"display_name":"Helper","system_prompt":"Be kind.","model":"m1","provider":"zai","x_future":{"a":1},"name_pool":["a"],"parallelism":2,"respond_to":"owner-only"}';

function latest(overrides = {}) {
  return {
    id: "b".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30175,
    created_at: 1000,
    tags: [
      ["d", "helper"],
      ["zz", "1"],
    ],
    content: BASE_CONTENT,
    sig: "0".repeat(128),
    ...overrides,
  };
}

function edits(overrides = {}) {
  return {
    displayName: "Helper",
    systemPrompt: "Be kind.",
    model: "m1",
    provider: "zai",
    ...overrides,
  };
}

test("editing only model rewrites that value and keeps every other key byte-identical", () => {
  const result = buildPersonaUpdate(latest(), edits({ model: "m2" }), 5000);
  assert.equal(
    result.template.content,
    '{"display_name":"Helper","system_prompt":"Be kind.","model":"m2","provider":"zai","x_future":{"a":1},"name_pool":["a"],"parallelism":2,"respond_to":"owner-only"}',
  );
  assert.equal(result.template.kind, 30175);
});

test("unknown content keys and unknown tags survive exactly", () => {
  const base = latest();
  const result = buildPersonaUpdate(base, edits({ displayName: "New" }), 5000);
  const content = JSON.parse(result.template.content);
  assert.deepEqual(content.x_future, { a: 1 });
  assert.deepEqual(result.template.tags, [
    ["d", "helper"],
    ["zz", "1"],
  ]);
  // Tags are copied, not aliased.
  assert.notEqual(result.template.tags[0], base.tags[0]);
});

test("desktop parse contract: known keys keep their string/array/number types", () => {
  const result = buildPersonaUpdate(latest(), edits({ model: "m2" }), 5000);
  const content = JSON.parse(result.template.content);
  assert.equal(typeof content.display_name, "string");
  assert.deepEqual(content.name_pool, ["a"]);
  assert.equal(content.parallelism, 2);
  assert.equal(content.respond_to, "owner-only");
});

test("a blank model deletes the key", () => {
  const result = buildPersonaUpdate(latest(), edits({ model: "  " }), 5000);
  const content = JSON.parse(result.template.content);
  assert.equal("model" in content, false);
  assert.equal(content.provider, "zai");
});

test("created_at is latest+1 when now is not ahead, else now", () => {
  assert.equal(
    buildPersonaUpdate(latest(), edits({ model: "m2" }), 900).template
      .created_at,
    1001,
  );
  assert.equal(
    buildPersonaUpdate(latest(), edits({ model: "m2" }), 1000).template
      .created_at,
    1001,
  );
  assert.equal(
    buildPersonaUpdate(latest(), edits({ model: "m2" }), 5000).template
      .created_at,
    5000,
  );
});

test("an empty display name is refused", () => {
  assert.deepEqual(
    buildPersonaUpdate(latest(), edits({ displayName: "   " }), 5000),
    { error: "Display name is required" },
  );
});

test("an invisible character in the prompt is refused with the Rust wording", () => {
  assert.deepEqual(
    buildPersonaUpdate(latest(), edits({ systemPrompt: "Be​kind." }), 5000),
    {
      error:
        "Agent instructions contains prohibited invisible or formatting character U+200B",
    },
  );
});

test("a no-op edit is refused", () => {
  assert.deepEqual(buildPersonaUpdate(latest(), edits(), 5000), {
    error: "No changes to save.",
  });
});

test("non-object or invalid content is refused", () => {
  for (const content of ["[1,2]", "null", '"str"', "{bad"]) {
    const result = buildPersonaUpdate(latest({ content }), edits(), 5000);
    assert.equal(typeof result.error, "string", content);
    assert.equal(result.template, undefined);
  }
});

function row(personaId, persona = { id: personaId }) {
  return { entry: { personaId }, persona };
}

test("definitionEditable: unlinked, builtin, missing persona, editable", () => {
  assert.deepEqual(definitionEditable(row(null, null)), {
    ok: false,
    reason: "This agent isn't linked to a definition.",
  });
  assert.deepEqual(definitionEditable(row("builtin:fizz")), {
    ok: false,
    reason: "Built-in definitions can't be edited.",
  });
  assert.deepEqual(definitionEditable(row("helper", null)), {
    ok: false,
    reason: "Definition not found on the relay — edit it in the desktop app.",
  });
  assert.deepEqual(definitionEditable(row("helper")), { ok: true });
});

test("agentsSharingDefinition returns only rows linked to that id", () => {
  const roster = [row("helper"), row("other"), row("helper"), row(null, null)];
  assert.equal(agentsSharingDefinition(roster, "helper").length, 2);
  assert.equal(agentsSharingDefinition(roster, "missing").length, 0);
});

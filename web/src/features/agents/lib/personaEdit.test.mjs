import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentsSharingDefinition,
  buildPersonaUpdate,
  buildPersonaDuplicate,
  personaNamePool,
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

const COPY_ID = "b5416ed8-a623-42ca-850f-e5cd17687726";

test("duplicate gets a new d and identical prompt bytes", () => {
  const prompt = " \tReview **literal** [links](https://iana.org).\n\n ";
  const base = latest({
    content: JSON.stringify({
      display_name: "Helper",
      system_prompt: prompt,
      name_pool: ["A", "B"],
      avatar_url: "https://iana.org/avatar.png",
      runtime: "codex",
      model: "m1",
      provider: "zai",
      respond_to: "owner-only",
      parallelism: 2,
      x_future: { keep: true },
    }),
    tags: [
      ["d", "helper"],
      ["shared", "true"],
      ["zz", "1"],
    ],
  });
  const result = buildPersonaDuplicate(base, COPY_ID, 900);
  assert.equal(result.template.kind, 30175);
  assert.deepEqual(result.template.tags, [
    ["d", COPY_ID],
    ["zz", "1"],
  ]);
  assert.equal(result.template.created_at, 900);
  assert.deepEqual(JSON.parse(result.template.content), {
    ...JSON.parse(base.content),
    display_name: "Helper (copy)",
  });
  assert.equal(JSON.parse(result.template.content).system_prompt, prompt);
  assert.equal(JSON.parse(base.content).display_name, "Helper");
});

test("duplicate refuses reused or non-UUID coordinates", () => {
  for (const id of ["helper", "", "invalid", COPY_ID.toUpperCase()]) {
    assert.equal(
      buildPersonaDuplicate(latest(), id, 1).error,
      "The copy needs a fresh definition id.",
    );
  }
  assert.equal(
    buildPersonaDuplicate(latest({ tags: [["d", COPY_ID]] }), COPY_ID, 1).error,
    "The copy needs a fresh definition id.",
  );
});

test("duplicate refuses invalid JSON and names exceeding the desktop bound", () => {
  for (const content of ["[1]", "null", "{bad", '"string"']) {
    assert.equal(
      typeof buildPersonaDuplicate(latest({ content }), COPY_ID, 1).error,
      "string",
    );
  }
  const base = latest({
    content: JSON.stringify({
      display_name: "a".repeat(123),
      system_prompt: "",
    }),
  });
  assert.match(
    buildPersonaDuplicate(base, COPY_ID, 1).error,
    /Display name is too long/,
  );
});

test("duplicate rejects malformed prompt and name pool wire types", () => {
  for (const fields of [
    { system_prompt: 42 },
    { name_pool: "Alice" },
    { name_pool: ["Alice", 42] },
  ]) {
    const base = latest({
      content: JSON.stringify({ display_name: "Helper", ...fields }),
    });
    assert.equal(
      buildPersonaDuplicate(base, COPY_ID, 1).error,
      "The current definition has invalid instructions or names.",
    );
  }
});

test("name pool round-trips", () => {
  const base = latest();
  const result = buildPersonaUpdate(
    base,
    edits({ namePool: ["Alice", "Bob", "Alice"] }),
    5000,
  );
  assert.deepEqual(personaNamePool(result.template.content), [
    "Alice",
    "Bob",
    "Alice",
  ]);
  assert.deepEqual(JSON.parse(result.template.content), {
    ...JSON.parse(base.content),
    name_pool: ["Alice", "Bob", "Alice"],
  });
  assert.deepEqual(
    buildPersonaUpdate(
      { ...base, ...result.template },
      edits({ namePool: ["Alice", "Bob", "Alice"] }),
      5001,
    ),
    { error: "No changes to save." },
  );
});

test("name pool clear removes the optional wire field", () => {
  const result = buildPersonaUpdate(latest(), edits({ namePool: [] }), 5000);
  assert.equal("name_pool" in JSON.parse(result.template.content), false);
  assert.deepEqual(personaNamePool(result.template.content), []);
});

test("name pool keeps order and rejects invisible names before trimming", () => {
  const result = buildPersonaUpdate(
    latest(),
    edits({ namePool: [" Bob ", "Alice"] }),
    5000,
  );
  assert.deepEqual(personaNamePool(result.template.content), ["Bob", "Alice"]);
  for (const name of ["\uFEFFBob", "Bo\u202Eb", "\u200B", ""]) {
    assert.match(
      buildPersonaUpdate(latest(), edits({ namePool: [name] }), 5000).error,
      /^Name pool:/,
    );
  }
});

test("name pool reader tolerates absent and malformed content", () => {
  for (const content of [
    "{}",
    "null",
    "{bad",
    '{"name_pool":1}',
    '{"name_pool":["a",1]}',
  ]) {
    assert.deepEqual(personaNamePool(content), []);
  }
});

test("bidi character in prompt is rejected with a message", () => {
  const result = buildPersonaUpdate(
    latest(),
    edits({ systemPrompt: "Be \u202Ekind." }),
    5000,
  );
  assert.deepEqual(result, {
    error:
      "Agent instructions contains prohibited invisible or formatting character U+202E",
  });
  const duplicate = buildPersonaDuplicate(
    latest({
      content: JSON.stringify({
        display_name: "Helper",
        system_prompt: "Be \u202Ekind.",
      }),
    }),
    COPY_ID,
    5000,
  );
  assert.deepEqual(duplicate, result);
});

test("prompt bytes survive edits and leading invisible formatting is never stripped", () => {
  const prompt = " \n\tBe kind.\n ";
  const result = buildPersonaUpdate(
    latest(),
    edits({ systemPrompt: prompt }),
    5000,
  );
  assert.equal(JSON.parse(result.template.content).system_prompt, prompt);
  assert.match(
    buildPersonaUpdate(
      latest(),
      edits({ systemPrompt: "\uFEFFBe kind." }),
      5000,
    ).error,
    /U\+FEFF/,
  );
  assert.match(
    buildPersonaUpdate(latest(), edits({ displayName: "\uFEFFHelper" }), 5000)
      .error,
    /U\+FEFF/,
  );
});

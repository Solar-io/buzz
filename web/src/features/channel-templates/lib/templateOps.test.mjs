import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDraft } from "./templateModel.ts";
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  updateTemplate,
} from "./templateOps.ts";

function deps(
  ids = ["id-1", "id-2", "id-3"],
  stamps = ["2026-01-01T00:00:00Z"],
) {
  let idIndex = 0;
  let stampIndex = 0;
  return {
    newId: () => ids[Math.min(idIndex++, ids.length - 1)],
    now: () => stamps[Math.min(stampIndex++, stamps.length - 1)],
  };
}

function draft(overrides = {}) {
  return { ...emptyDraft(), name: "Standup", ...overrides };
}

test("create stamps id, both timestamps, and is_builtin false", () => {
  const result = createTemplate([], draft(), deps());
  assert.ok("template" in result);
  assert.equal(result.template.id, "id-1");
  assert.equal(result.template.createdAt, "2026-01-01T00:00:00Z");
  assert.equal(result.template.updatedAt, "2026-01-01T00:00:00Z");
  assert.equal(result.template.isBuiltin, false);
  assert.equal(result.templates.length, 1);
});

test("create trims the name and collapses blank optionals to null", () => {
  const result = createTemplate(
    [],
    draft({ name: "  Standup  ", description: "   ", canvasTemplate: "  " }),
    deps(),
  );
  assert.ok("template" in result);
  assert.equal(result.template.name, "Standup");
  assert.equal(result.template.description, null);
  assert.equal(result.template.canvasTemplate, null);
});

test("create keeps a non-blank description, trimmed", () => {
  const result = createTemplate(
    [],
    draft({ description: "  planning  " }),
    deps(),
  );
  assert.ok("template" in result);
  assert.equal(result.template.description, "planning");
});

test("create refuses an invalid draft and leaves the list alone", () => {
  const existing = [];
  const result = createTemplate(existing, draft({ name: "" }), deps());
  assert.deepEqual(result, { error: "Template name is required" });
  assert.equal(existing.length, 0);
});

test("update changes updated_at but preserves created_at and id", () => {
  const created = createTemplate([], draft(), deps(["id-1"], ["T0"]));
  const result = updateTemplate(
    created.templates,
    "id-1",
    draft({ name: "Renamed" }),
    deps(["id-9"], ["T1"]),
  );
  assert.ok("template" in result);
  assert.equal(result.template.id, "id-1");
  assert.equal(result.template.name, "Renamed");
  assert.equal(result.template.createdAt, "T0");
  assert.equal(result.template.updatedAt, "T1");
});

test("update of a missing id is an error", () => {
  const result = updateTemplate([], "nope", draft(), deps());
  assert.deepEqual(result, { error: "template nope not found" });
});

/**
 * The duplicate must be independently editable. Asserting `isBuiltin === false`
 * on a duplicate OF A BUILT-IN is the discriminating case: duplicating a custom
 * template would read false either way.
 */
test("duplicating a built-in yields an editable, deletable copy", () => {
  const builtin = {
    id: "seed",
    name: "Seeded",
    description: null,
    channelType: "stream",
    visibility: "open",
    canvasTemplate: null,
    agents: { personas: [], teams: [] },
    isBuiltin: true,
    createdAt: "T0",
    updatedAt: "T0",
  };
  const result = duplicateTemplate([builtin], "seed", deps(["copy-1"], ["T1"]));
  assert.ok("template" in result);
  assert.equal(result.template.id, "copy-1");
  assert.equal(result.template.name, "Seeded (Copy)");
  assert.equal(result.template.isBuiltin, false);
  assert.equal(result.template.createdAt, "T1");
  assert.equal(deleteTemplate(result.templates, "copy-1").error, undefined);
});

test("duplicate carries the roster across", () => {
  const created = createTemplate(
    [],
    draft({
      agents: {
        personas: [
          {
            personaId: "p1",
            runtime: null,
            model: null,
            role: null,
            backend: null,
          },
        ],
        teams: [],
      },
    }),
    deps(["id-1"]),
  );
  const result = duplicateTemplate(created.templates, "id-1", deps(["id-2"]));
  assert.ok("template" in result);
  assert.equal(result.template.agents.personas[0].personaId, "p1");
});

test("delete removes a custom template", () => {
  const created = createTemplate([], draft(), deps(["id-1"]));
  const result = deleteTemplate(created.templates, "id-1");
  assert.deepEqual(result, { templates: [] });
});

test("delete refuses a built-in", () => {
  const builtin = {
    id: "seed",
    name: "Seeded",
    description: null,
    channelType: "stream",
    visibility: "open",
    canvasTemplate: null,
    agents: { personas: [], teams: [] },
    isBuiltin: true,
    createdAt: "T0",
    updatedAt: "T0",
  };
  assert.deepEqual(deleteTemplate([builtin], "seed"), {
    error: "Built-in templates cannot be deleted.",
  });
});

test("the roster is copied, not aliased, into the stored record", () => {
  const source = draft({
    agents: {
      personas: [
        {
          personaId: "p1",
          runtime: null,
          model: null,
          role: null,
          backend: null,
        },
      ],
      teams: [],
    },
  });
  const result = createTemplate([], source, deps());
  assert.ok("template" in result);
  source.agents.personas[0].personaId = "mutated";
  assert.equal(result.template.agents.personas[0].personaId, "p1");
});

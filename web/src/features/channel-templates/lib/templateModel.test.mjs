import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftIssue,
  deletionIssue,
  emptyDraft,
  mergeImported,
  parseTemplatesFile,
  serializeTemplates,
  sortTemplates,
  templateFromWire,
  templateToWire,
} from "./templateModel.ts";

function template(overrides = {}) {
  return {
    id: "t1",
    name: "Sprint Planning",
    description: null,
    channelType: "stream",
    visibility: "open",
    canvasTemplate: null,
    agents: { personas: [], teams: [] },
    isBuiltin: false,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...overrides,
  };
}

// ── sort: mirrors sort_channel_templates ────────────────────────────────────

test("sort is case-insensitive by name", () => {
  const names = sortTemplates([
    template({ id: "3", name: "Zulu" }),
    template({ id: "1", name: "alpha" }),
    template({ id: "2", name: "Bravo" }),
  ]).map((t) => t.name);
  assert.deepEqual(names, ["alpha", "Bravo", "Zulu"]);
});

test("sort puts built-ins first even when their name sorts last", () => {
  const sorted = sortTemplates([
    template({ id: "a", name: "Apple" }),
    template({ id: "b", name: "Zebra", isBuiltin: true }),
  ]);
  assert.equal(sorted[0].name, "Zebra");
  assert.equal(sorted[0].isBuiltin, true);
  assert.equal(sorted[1].name, "Apple");
});

test("sort breaks name ties by id", () => {
  const ids = sortTemplates([
    template({ id: "b", name: "same" }),
    template({ id: "a", name: "same" }),
  ]).map((t) => t.id);
  assert.deepEqual(ids, ["a", "b"]);
});

// ── validation: mirrors commands/channel_templates.rs ───────────────────────

test("a blank name is rejected", () => {
  assert.equal(
    draftIssue({ ...emptyDraft(), name: "   " }),
    "Template name is required",
  );
});

test("a name of only whitespace-padded text is accepted", () => {
  assert.equal(draftIssue({ ...emptyDraft(), name: "  Standup  " }), null);
});

test("an out-of-range channel type is rejected by name", () => {
  const issue = draftIssue({
    ...emptyDraft(),
    name: "x",
    channelType: "thread",
  });
  assert.match(issue ?? "", /invalid channel type: "thread"/);
});

test("an out-of-range visibility is rejected by name", () => {
  const issue = draftIssue({
    ...emptyDraft(),
    name: "x",
    visibility: "secret",
  });
  assert.match(issue ?? "", /invalid visibility: "secret"/);
});

test("forum + private is a legal combination", () => {
  assert.equal(
    draftIssue({
      ...emptyDraft(),
      name: "x",
      channelType: "forum",
      visibility: "private",
    }),
    null,
  );
});

test("built-ins cannot be deleted and customs can", () => {
  assert.equal(
    deletionIssue(template({ isBuiltin: true })),
    "Built-in templates cannot be deleted.",
  );
  assert.equal(deletionIssue(template({ isBuiltin: false })), null);
});

// ── wire form: byte-compatible with the desktop's JSON file ─────────────────

/**
 * The desktop record shape, transcribed from templates/types.rs. Top level is
 * snake_case; the roster entries are camelCase. If either half drifts, the
 * export stops importing on desktop, which no unit test on that side notices.
 */
const DESKTOP_RECORD = {
  id: "t1",
  name: "Sprint Planning",
  description: "Template for sprint channels",
  channel_type: "stream",
  visibility: "private",
  canvas_template: "# {channel.name}\n\nSprint goals here",
  agents: {
    personas: [
      {
        personaId: "builtin:fizz",
        runtime: "claude",
        model: "opus",
        role: "bot",
        backend: { type: "local" },
      },
    ],
    teams: [
      {
        teamId: "team-1",
        backend: { type: "provider", id: "provider-1" },
      },
    ],
  },
  is_builtin: false,
  created_at: "2026-05-11T00:00:00Z",
  updated_at: "2026-05-11T00:00:00Z",
};

test("a desktop record parses with every field intact", () => {
  const parsed = templateFromWire(DESKTOP_RECORD);
  assert.ok(parsed);
  assert.equal(parsed.channelType, "stream");
  assert.equal(parsed.visibility, "private");
  assert.equal(parsed.description, "Template for sprint channels");
  assert.equal(parsed.canvasTemplate, "# {channel.name}\n\nSprint goals here");
  assert.equal(parsed.agents.personas.length, 1);
  assert.equal(parsed.agents.personas[0].personaId, "builtin:fizz");
  assert.equal(parsed.agents.personas[0].runtime, "claude");
  assert.deepEqual(parsed.agents.personas[0].backend, { type: "local" });
  assert.equal(parsed.agents.teams.length, 1);
  assert.equal(parsed.agents.teams[0].teamId, "team-1");
  assert.deepEqual(parsed.agents.teams[0].backend, {
    type: "provider",
    id: "provider-1",
  });
});

test("a desktop record round-trips back to the identical wire object", () => {
  const parsed = templateFromWire(DESKTOP_RECORD);
  assert.deepEqual(templateToWire(parsed), DESKTOP_RECORD);
});

test("the serde `provider` alias resolves to runtime", () => {
  const parsed = templateFromWire({
    ...DESKTOP_RECORD,
    agents: { personas: [{ personaId: "p", provider: "codex" }], teams: [] },
  });
  assert.equal(parsed.agents.personas[0].runtime, "codex");
});

test("absent optionals are omitted, not serialised as null", () => {
  const wire = templateToWire(template());
  assert.equal("description" in wire, false);
  assert.equal("canvas_template" in wire, false);
  // An empty roster still round-trips as an object with no arrays, matching
  // skip_serializing_if = "Vec::is_empty".
  assert.deepEqual(wire.agents, {});
});

test("channel_type and visibility fall back to the serde defaults", () => {
  const parsed = templateFromWire({
    id: "x",
    name: "n",
    created_at: "a",
    updated_at: "b",
  });
  assert.equal(parsed.channelType, "stream");
  assert.equal(parsed.visibility, "open");
});

test("records missing an id or a name do not parse", () => {
  assert.equal(templateFromWire({ name: "n" }), null);
  assert.equal(templateFromWire({ id: "x", name: "   " }), null);
  assert.equal(templateFromWire(null), null);
});

test("a partially corrupt file imports the records it understands", () => {
  const parsed = parseTemplatesFile(
    JSON.stringify([DESKTOP_RECORD, { name: "no id" }, 42]),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "t1");
});

test("a single record (not an array) still imports", () => {
  assert.equal(parseTemplatesFile(JSON.stringify(DESKTOP_RECORD)).length, 1);
});

test("unparseable text imports nothing rather than throwing", () => {
  assert.deepEqual(parseTemplatesFile("{not json"), []);
});

test("serializeTemplates emits a sorted array with a trailing newline", () => {
  const text = serializeTemplates([
    template({ id: "b", name: "Zulu" }),
    template({ id: "a", name: "alpha" }),
  ]);
  assert.equal(text.endsWith("\n"), true);
  const rows = JSON.parse(text);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["alpha", "Zulu"],
  );
});

// ── import merge ────────────────────────────────────────────────────────────

test("an import cannot mint a built-in", () => {
  const merged = mergeImported([], [template({ isBuiltin: true })]);
  assert.equal(merged[0].isBuiltin, false);
});

test("a newer imported record replaces an older local one", () => {
  const merged = mergeImported(
    [template({ name: "Old", updatedAt: "2026-01-01T00:00:00Z" })],
    [template({ name: "New", updatedAt: "2026-06-01T00:00:00Z" })],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "New");
});

test("an older imported record does not clobber a newer local one", () => {
  const merged = mergeImported(
    [template({ name: "New", updatedAt: "2026-06-01T00:00:00Z" })],
    [template({ name: "Old", updatedAt: "2026-01-01T00:00:00Z" })],
  );
  assert.equal(merged[0].name, "New");
});

test("an import never overwrites a local built-in", () => {
  const merged = mergeImported(
    [template({ name: "Seeded", isBuiltin: true })],
    [template({ name: "Impostor", updatedAt: "2099-01-01T00:00:00Z" })],
  );
  assert.equal(merged[0].name, "Seeded");
});

test("a new id is added alongside the existing set", () => {
  const merged = mergeImported(
    [template({ id: "a", name: "A" })],
    [template({ id: "b", name: "B" })],
  );
  assert.equal(merged.length, 2);
});

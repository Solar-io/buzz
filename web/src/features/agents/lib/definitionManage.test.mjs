import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCoordinateDelete,
  buildPersonaCreate,
  buildShareToggle,
  deleteBlockers,
  isSharedEvent,
  webManageable,
} from "./definitionManage.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OWNER = "a".repeat(64);
const PK = "b".repeat(64);

function input(overrides = {}) {
  return {
    displayName: "  Helper  ",
    systemPrompt: "Be kind. ",
    avatarUrl: "",
    runtime: "",
    model: "",
    provider: "",
    respondTo: "owner-only",
    respondToAllowlist: [],
    parallelism: null,
    ...overrides,
  };
}

function head(overrides = {}) {
  return {
    id: "c".repeat(64),
    pubkey: OWNER,
    kind: 30175,
    created_at: 1000,
    tags: [
      ["d", UUID],
      ["zz", "1"],
    ],
    content: '{"display_name":"Helper","system_prompt":"Be kind.","x":1}',
    sig: "0".repeat(128),
    ...overrides,
  };
}

// ── create ───────────────────────────────────────────────────────────────────

test("create: minimal content is exact, prompt kept byte-for-byte, blanks omitted", () => {
  const result = buildPersonaCreate(input(), UUID, 5000);
  assert.equal(
    result.template.content,
    '{"display_name":"Helper","system_prompt":"Be kind. ","respond_to":"owner-only"}',
  );
  assert.deepEqual(result.template.tags, [["d", UUID]]);
  assert.equal(result.template.kind, 30175);
  assert.equal(result.template.created_at, 5000);
});

test("create: empty prompt is still written as system_prompt:\"\"", () => {
  const result = buildPersonaCreate(input({ systemPrompt: "" }), UUID, 1);
  assert.equal(
    result.template.content,
    '{"display_name":"Helper","system_prompt":"","respond_to":"owner-only"}',
  );
});

test("create: full content follows PersonaEventContent key order", () => {
  const result = buildPersonaCreate(
    input({
      avatarUrl: " https://x/a.png ",
      runtime: "goose",
      model: "glm-5",
      provider: "openrouter",
      respondTo: "allowlist",
      respondToAllowlist: [` ${PK} `, ""],
      parallelism: 4,
    }),
    UUID,
    1,
  );
  assert.equal(
    result.template.content,
    `{"display_name":"Helper","system_prompt":"Be kind. ","avatar_url":"https://x/a.png","runtime":"goose","model":"glm-5","provider":"openrouter","respond_to":"allowlist","respond_to_allowlist":["${PK}"],"parallelism":4}`,
  );
});

test("create: allowlist dropped outside allowlist mode", () => {
  const result = buildPersonaCreate(
    input({ respondTo: "anyone", respondToAllowlist: [PK] }),
    UUID,
    1,
  );
  assert.equal(
    result.template.content,
    '{"display_name":"Helper","system_prompt":"Be kind. ","respond_to":"anyone"}',
  );
});

test("create: rejects a non-UUID d tag", () => {
  assert.equal(
    buildPersonaCreate(input(), "helper", 1).error,
    "Internal error: the new definition id is not a UUID.",
  );
  assert.ok(
    "error" in buildPersonaCreate(input(), UUID.toUpperCase(), 1),
    "uppercase UUID is not canonical",
  );
});

test("create: rejects a U+200B prompt with the Rust wording", () => {
  const result = buildPersonaCreate(
    input({ systemPrompt: "a​b" }),
    UUID,
    1,
  );
  assert.equal(
    result.error,
    "Agent instructions contains prohibited invisible or formatting character U+200B",
  );
});

test("create: rejects parallelism 0 and 33, accepts 1 and 32", () => {
  assert.equal(
    buildPersonaCreate(input({ parallelism: 0 }), UUID, 1).error,
    "parallelism 0 is out of range (must be between 1 and 32)",
  );
  assert.equal(
    buildPersonaCreate(input({ parallelism: 33 }), UUID, 1).error,
    "parallelism 33 is out of range (must be between 1 and 32)",
  );
  assert.ok("template" in buildPersonaCreate(input({ parallelism: 1 }), UUID, 1));
  assert.ok(
    "template" in buildPersonaCreate(input({ parallelism: 32 }), UUID, 1),
  );
});

test("create: allowlist mode without pubkeys is refused", () => {
  assert.equal(
    buildPersonaCreate(
      input({ respondTo: "allowlist", respondToAllowlist: [" "] }),
      UUID,
      1,
    ).error,
    "respond-to mode 'allowlist' requires at least one pubkey in the allowlist",
  );
});

test("create: blank name refused", () => {
  assert.equal(
    buildPersonaCreate(input({ displayName: "  " }), UUID, 1).error,
    "Definition name is required.",
  );
});

// ── share ────────────────────────────────────────────────────────────────────

test("share on: appends one shared tag, keeps unknown tags and content bytes", () => {
  const base = head();
  const result = buildShareToggle(base, true, 500);
  assert.deepEqual(result.template.tags, [
    ["d", UUID],
    ["zz", "1"],
    ["shared", "true"],
  ]);
  assert.equal(result.template.content, base.content);
  assert.equal(result.template.created_at, 1001);
});

test("share off: removes the shared tag, created_at uses now when later", () => {
  const result = buildShareToggle(
    head({ tags: [["d", UUID], ["shared", "true"], ["zz", "1"]] }),
    false,
    9000,
  );
  assert.deepEqual(result.template.tags, [
    ["d", UUID],
    ["zz", "1"],
  ]);
  assert.equal(result.template.created_at, 9000);
});

test("share on: duplicate shared tags collapse to exactly one", () => {
  const result = buildShareToggle(
    head({
      tags: [
        ["d", UUID],
        ["shared", "true"],
        ["shared", "true"],
      ],
    }),
    true,
    1,
  );
  assert.deepEqual(result.template.tags, [
    ["d", UUID],
    ["shared", "true"],
  ]);
});

test("share: no-op returns an error", () => {
  assert.equal(buildShareToggle(head(), false, 1).error, "Already private.");
  assert.equal(
    buildShareToggle(head({ tags: [["d", UUID], ["shared", "true"]] }), true, 1)
      .error,
    "Already shared.",
  );
});

test("share on: an unsafe prompt is refused", () => {
  const result = buildShareToggle(
    head({ content: '{"display_name":"H","system_prompt":"a\\u200Bb"}' }),
    true,
    1,
  );
  assert.equal(
    result.error,
    "Agent instructions contains prohibited invisible or formatting character U+200B",
  );
});

test("isSharedEvent mirrors event_is_shared", () => {
  assert.equal(isSharedEvent({ tags: [["shared", "true"]] }), true);
  assert.equal(isSharedEvent({ tags: [] }), false);
  assert.equal(isSharedEvent({ tags: [["shared", "yes"]] }), false);
  assert.equal(
    isSharedEvent({ tags: [["shared", "true", "extra"]] }),
    false,
  );
  assert.equal(
    isSharedEvent({
      tags: [
        ["shared", "true"],
        ["shared", "true"],
      ],
    }),
    false,
  );
});

// ── delete ───────────────────────────────────────────────────────────────────

test("webManageable: UUID yes, slug and builtin no", () => {
  assert.deepEqual(webManageable(UUID), { ok: true });
  assert.equal(webManageable("helper").ok, false);
  assert.equal(webManageable("builtin:solo").ok, false);
});

const team = (overrides = {}) => ({
  id: "t1",
  name: "T",
  description: null,
  instructions: null,
  membershipUnknown: false,
  personaIds: [],
  updatedAt: 1,
  eventId: "e",
  ...overrides,
});

test("deleteBlockers: non-UUID", () => {
  assert.equal(
    deleteBlockers("helper", "Helper", [], new Map()),
    "This definition was installed with a team or built in — delete it in the desktop app.",
  );
});

test("deleteBlockers: referenced by a team", () => {
  assert.equal(
    deleteBlockers(
      UUID,
      "Helper",
      [],
      new Map([["t1", team({ personaIds: [UUID] })]]),
    ),
    "Helper is still referenced by a team. Remove it from those teams first.",
  );
});

test("deleteBlockers: a membership-unknown team fails closed", () => {
  assert.equal(
    deleteBlockers(
      UUID,
      "Helper",
      [],
      new Map([["t1", team({ membershipUnknown: true })]]),
    ),
    "Helper is still referenced by a team. Remove it from those teams first.",
  );
});

test("deleteBlockers: linked agents refuse", () => {
  const roster = [
    { entry: { personaId: UUID }, name: "A" },
    { entry: { personaId: "other" }, name: "X" },
    { entry: { personaId: UUID }, name: "B" },
  ];
  assert.equal(
    deleteBlockers(UUID, "Helper", roster, new Map([["t1", team()]])),
    "2 agents use this definition (A, B). Delete those agents first.",
  );
  assert.equal(
    deleteBlockers(UUID, "Helper", roster.slice(0, 1), new Map()),
    "1 agent uses this definition (A). Delete those agents first.",
  );
});

test("deleteBlockers: clear", () => {
  assert.equal(
    deleteBlockers(
      UUID,
      "Helper",
      [{ entry: { personaId: null }, name: "N" }],
      new Map([["t1", team({ personaIds: ["other"] })]]),
    ),
    null,
  );
});

test("buildCoordinateDelete: exact a-tag, no e-tag, empty content", () => {
  const result = buildCoordinateDelete(30175, OWNER, UUID, 100, 200);
  assert.deepEqual(result.template, {
    kind: 5,
    tags: [["a", `30175:${OWNER}:${UUID}`]],
    content: "",
    created_at: 200,
  });
  assert.equal(
    buildCoordinateDelete(30176, OWNER, "t", 1, 2).template.tags[0][1],
    `30176:${OWNER}:t`,
  );
});

test("buildCoordinateDelete: created_at equals a future head", () => {
  assert.equal(
    buildCoordinateDelete(30175, OWNER, UUID, 9999, 200).template.created_at,
    9999,
  );
});

test("buildCoordinateDelete: non-hex owner and empty d are rejected", () => {
  assert.equal(
    buildCoordinateDelete(30175, "A".repeat(64), UUID, 1, 1).error,
    "Owner key must be 64 lowercase hex characters.",
  );
  assert.equal(
    buildCoordinateDelete(30175, UUID, UUID, 1, 1).error,
    "Owner key must be 64 lowercase hex characters.",
  );
  assert.equal(
    buildCoordinateDelete(30175, OWNER, "", 1, 1).error,
    "Coordinate d tag is empty.",
  );
});

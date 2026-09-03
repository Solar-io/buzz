import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeTeam, teamFromEvent } from "./teamEvents.ts";

/**
 * Kind-30176 wire semantics — the Sietch-Tabr vectors ported from
 * `desktop/src-tauri/src/managed_agents/team_events.rs` tests, plus the
 * merge tie-break. Raw JSON strings (not constructed objects) so the tests
 * exercise the exact serde-shape mapping, exactly as the Rust suite does.
 *
 * NAMED MUTATION (tester): in teamEvents.ts change
 * `const membershipUnknown = object.persona_ids === undefined;` to
 * `const membershipUnknown = false;` then
 * `legacy event without persona_ids parses as membership-unknown` must FAIL.
 * Revert.
 */

function teamEvent(content, overrides = {}) {
  return {
    id: "e1",
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000,
    kind: 30176,
    tags: [["d", "team-123"]],
    content,
    sig: "sig",
    ...overrides,
  };
}

test("full projection round-trips the published fields", () => {
  const team = teamFromEvent(
    teamEvent(
      JSON.stringify({
        name: "Test Team",
        description: "A test team",
        instructions: "Coordinate carefully.",
        persona_ids: ["p1", "p2"],
      }),
    ),
  );
  assert.deepEqual(team, {
    id: "team-123",
    name: "Test Team",
    description: "A test team",
    instructions: "Coordinate carefully.",
    membershipUnknown: false,
    personaIds: ["p1", "p2"],
    updatedAt: 1_700_000_000,
    eventId: "e1",
  });
});

// ── persona_ids wire semantics (omission must not read as empty) ────────

test("legacy event without persona_ids parses as membership-unknown", () => {
  // The exact shape of the Sietch Tabr wipe event: an old client's event
  // must read back UNKNOWN, never "explicitly empty" — that conflation is
  // what wiped team membership.
  const team = teamFromEvent(teamEvent('{"name":"Old Team"}'));
  assert.equal(team.membershipUnknown, true);
  assert.deepEqual(team.personaIds, []);
});

test("explicit empty persona_ids is known-empty, not unknown", () => {
  // New clients always publish Some, even for an empty list — [] is the
  // explicit no-members signal a pre-fix client can never produce.
  const team = teamFromEvent(
    teamEvent('{"name":"Team","persona_ids":[]}'),
  );
  assert.equal(team.membershipUnknown, false);
  assert.deepEqual(team.personaIds, []);
});

test("persona_ids list parses and drops non-string entries", () => {
  const team = teamFromEvent(
    teamEvent('{"name":"Team","persona_ids":["p1",7,"p2"]}'),
  );
  assert.equal(team.membershipUnknown, false);
  assert.deepEqual(team.personaIds, ["p1", "p2"]);
});

// ── instructions tri-state (absent / null / value) ──────────────────────

test("instructions absent parses as null", () => {
  const team = teamFromEvent(
    teamEvent('{"name":"Old Team","persona_ids":["p1"]}'),
  );
  assert.equal(team.instructions, null);
});

test("explicit null instructions parses as null", () => {
  const team = teamFromEvent(
    teamEvent('{"name":"Team","persona_ids":["p1"],"instructions":null}'),
  );
  assert.equal(team.instructions, null);
});

test("instructions value parses as the string", () => {
  const team = teamFromEvent(
    teamEvent(
      '{"name":"Team","persona_ids":["p1"],"instructions":"Coordinate."}',
    ),
  );
  assert.equal(team.instructions, "Coordinate.");
});

// ── shape guards ────────────────────────────────────────────────────────

test("wrong kind, bad JSON, missing d tag, or missing name → null", () => {
  assert.equal(teamFromEvent(teamEvent("{}", { kind: 30175 })), null);
  assert.equal(teamFromEvent(teamEvent("{not json")), null);
  assert.equal(teamFromEvent(teamEvent("{}", { tags: [] })), null);
  assert.equal(teamFromEvent(teamEvent('{"name":"x"}', { tags: [["d", ""]] })), null);
  assert.equal(teamFromEvent(teamEvent('{"persona_ids":["p1"]}')), null);
  assert.equal(teamFromEvent(teamEvent('{"name":42}')), null);
  assert.equal(teamFromEvent(teamEvent('{"name":"   "}')), null);
});

test("local-only / unknown fields in content are ignored, not fatal", () => {
  // The Rust serde ignores unknown fields; an event carrying install-local
  // fields (or future ones) still parses.
  const team = teamFromEvent(
    teamEvent(
      JSON.stringify({
        name: "Team",
        persona_ids: ["p1"],
        source_dir: "/local/only/path",
        is_builtin: false,
        version: "1.0",
      }),
    ),
  );
  assert.equal(team.name, "Team");
  assert.deepEqual(team.personaIds, ["p1"]);
});

// ── mergeTeam (newest-wins, tie: lower event id) ────────────────────────

function view(overrides = {}) {
  return {
    id: "team-123",
    name: "Team",
    description: null,
    instructions: null,
    membershipUnknown: false,
    personaIds: [],
    updatedAt: 100,
    eventId: "aa",
    ...overrides,
  };
}

test("newest event wins the coordinate", () => {
  let teams = new Map();
  teams = mergeTeam(teams, view({ eventId: "a", updatedAt: 100, name: "Old" }));
  teams = mergeTeam(teams, view({ eventId: "b", updatedAt: 200, name: "New" }));
  assert.equal(teams.get("team-123").name, "New");
  // Older arriving later still loses.
  teams = mergeTeam(teams, view({ eventId: "c", updatedAt: 50, name: "Older" }));
  assert.equal(teams.get("team-123").name, "New");
});

test("timestamp tie resolves to the lower event id", () => {
  let teams = new Map();
  teams = mergeTeam(teams, view({ eventId: "bb", updatedAt: 100, name: "B" }));
  teams = mergeTeam(teams, view({ eventId: "aa", updatedAt: 100, name: "A" }));
  assert.equal(teams.get("team-123").name, "A");
  // And the winner holds when the loser re-arrives.
  teams = mergeTeam(teams, view({ eventId: "bb", updatedAt: 100, name: "B" }));
  assert.equal(teams.get("team-123").name, "A");
});

test("distinct team ids are separate coordinates", () => {
  let teams = new Map();
  teams = mergeTeam(teams, view({ id: "t1", eventId: "a" }));
  teams = mergeTeam(teams, view({ id: "t2", eventId: "b" }));
  assert.equal(teams.size, 2);
});

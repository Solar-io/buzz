import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRosterGroups, teamNamesByPersonaId } from "./rosterGroups.ts";

/**
 * Roster grouping semantics — the web mirror of unifiedAgentGroups.ts
 * (persona groups / ungrouped / unknown) plus team badges.
 *
 * NAMED MUTATION (tester): in rosterGroups.ts change the unknown-bucket
 * branch `unknown.push(row); continue;` to `ungrouped.push(row); continue;`
 * then `linked agent with a missing definition lands in unknown` must FAIL.
 * Revert.
 */

function persona(id, name) {
  return {
    id,
    name,
    systemPrompt: "p",
    model: "glm-5.3",
    provider: "zai",
    runtime: "claude",
    updatedAt: 1,
  };
}

function row(pubkey, { personaId = null, name = `Agent ${pubkey}` } = {}) {
  return {
    pubkey,
    entry: {
      pubkey,
      name,
      systemPrompt: "",
      model: "",
      provider: "",
      personaId,
      parallelism: null,
      respondTo: "owner-only",
      respondToAllowlist: [],
      updatedAt: 1,
    },
    persona: null,
    name,
    systemPrompt: "",
    model: "",
    provider: "",
    personaLinked: personaId !== null,
    machines: [],
    duplicate: false,
  };
}

function team(
  id,
  { name = id, personaIds = [], membershipUnknown = false } = {},
) {
  return {
    id,
    name,
    description: null,
    instructions: null,
    membershipUnknown,
    personaIds,
    updatedAt: 1,
    eventId: "e",
  };
}

test("rows land in persona groups, ungrouped, and unknown", () => {
  const personas = new Map([["night", persona("night", "Night Shift")]]);
  const sections = buildRosterGroups(
    [
      row("aa", { personaId: "night" }),
      row("bb", { personaId: null }),
      row("cc", { personaId: "ghost" }), // definition missing
    ],
    personas,
  );
  assert.deepEqual(
    sections.map((s) => s.key),
    ["persona:night", "unknown", "ungrouped"],
  );
  assert.deepEqual(
    sections[0].rows.map((r) => r.pubkey),
    ["aa"],
  );
  assert.deepEqual(
    sections[1].rows.map((r) => r.pubkey),
    ["cc"],
  );
  assert.deepEqual(
    sections[2].rows.map((r) => r.pubkey),
    ["bb"],
  );
});

test("two agents on one persona share the group", () => {
  const personas = new Map([["night", persona("night", "Night Shift")]]);
  const sections = buildRosterGroups(
    [row("aa", { personaId: "night" }), row("bb", { personaId: "night" })],
    personas,
  );
  assert.equal(sections.length, 3);
  assert.equal(sections[0].rows.length, 2);
  assert.deepEqual(
    sections[0].rows.map((r) => r.pubkey),
    ["aa", "bb"],
  );
  // The trailing buckets exist but are empty.
  assert.deepEqual(sections[1].rows, []);
  assert.deepEqual(sections[2].rows, []);
});

test("persona groups sort by name and include zero-row personas", () => {
  const personas = new Map([
    ["zeta", persona("zeta", "Zeta Crew")],
    ["alpha", persona("alpha", "Alpha Crew")],
  ]);
  const sections = buildRosterGroups(
    [row("aa", { personaId: "alpha" })],
    personas,
  );
  assert.deepEqual(
    sections.map((s) => s.title),
    ["Alpha Crew", "Zeta Crew", "Unknown agents", "Custom agents"],
  );
  assert.deepEqual(sections[1].rows, []);
});

test("linked agent with a missing definition lands in unknown", () => {
  const sections = buildRosterGroups(
    [row("cc", { personaId: "ghost" })],
    new Map(),
  );
  const unknown = sections.find((s) => s.key === "unknown");
  const ungrouped = sections.find((s) => s.key === "ungrouped");
  assert.deepEqual(
    unknown.rows.map((r) => r.pubkey),
    ["cc"],
  );
  assert.deepEqual(ungrouped.rows, []);
});

test("team badges map personas to their team names", () => {
  const personas = new Map([
    ["night", persona("night", "Night Shift")],
    ["day", persona("day", "Day Crew")],
  ]);
  const teams = new Map([
    ["t1", team("t1", { name: "Ops", personaIds: ["night", "day"] })],
    ["t2", team("t2", { name: "Watch", personaIds: ["night"] })],
    [
      "t3",
      team("t3", {
        name: "Ghost Team",
        personaIds: ["night"],
        membershipUnknown: true,
      }),
    ],
  ]);
  const badges = teamNamesByPersonaId(personas.keys(), teams);
  assert.deepEqual(badges.get("night"), ["Ops", "Watch"]);
  assert.deepEqual(badges.get("day"), ["Ops"]);
});

test("membershipUnknown team contributes no badges", () => {
  const personas = new Map([["night", persona("night", "Night Shift")]]);
  const teams = new Map([
    [
      "t3",
      team("t3", {
        name: "Ghost Team",
        personaIds: ["night"],
        membershipUnknown: true,
      }),
    ],
  ]);
  const badges = teamNamesByPersonaId(personas.keys(), teams);
  assert.deepEqual(badges.get("night"), []);
});

test("team listing a persona outside the universe adds no badge entry", () => {
  // The missing persona surfaces as an unresolved-member COUNT in the teams
  // panel, not as a badge for a row that does not exist.
  const personas = new Map([["night", persona("night", "Night Shift")]]);
  const teams = new Map([
    ["t1", team("t1", { name: "Ops", personaIds: ["night", "ghost"] })],
  ]);
  const badges = teamNamesByPersonaId(personas.keys(), teams);
  assert.equal(badges.has("ghost"), false);
  assert.deepEqual(badges.get("night"), ["Ops"]);
});

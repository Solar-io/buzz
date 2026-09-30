import assert from "node:assert/strict";
import test from "node:test";

import { memberSubtitle, memberSummary } from "./memberSummary.ts";

const SAM = "a".repeat(64);
const GILFOYLE = "b".repeat(64);
const NIKON = "c".repeat(64);
const ACID = "d".repeat(64);
const CRASH = "e".repeat(64);
const AGENTS = new Set([GILFOYLE, NIKON, ACID, CRASH]);

test("people lead the facepile; the counts are members and agents", () => {
  // Roster order puts the person LAST; the pile still leads with them.
  const summary = memberSummary([GILFOYLE, NIKON, ACID, SAM], AGENTS);
  assert.deepEqual(summary, {
    faces: [SAM, GILFOYLE, NIKON, ACID],
    members: 4,
    agents: 3,
  });
  assert.equal(memberSubtitle(summary), "4 members · 3 agents");
});

test("the pile stops at four; the counts do not", () => {
  const summary = memberSummary([SAM, GILFOYLE, NIKON, ACID, CRASH], AGENTS);
  assert.deepEqual(summary.faces, [SAM, GILFOYLE, NIKON, ACID]);
  assert.equal(summary.members, 5);
  assert.equal(summary.agents, 4);
});

test("an unknown member is a person, a duplicate is one member", () => {
  // No agent set at all: nobody is claimed as an agent.
  assert.deepEqual(memberSummary([SAM, GILFOYLE]), {
    faces: [SAM, GILFOYLE],
    members: 2,
    agents: 0,
  });
  assert.equal(memberSubtitle(memberSummary([SAM, GILFOYLE])), "2 members");
  assert.equal(memberSummary([SAM, SAM], AGENTS).members, 1);
  assert.equal(memberSubtitle(memberSummary([SAM], AGENTS)), "1 member");
  assert.equal(
    memberSubtitle(memberSummary([SAM, NIKON], AGENTS)),
    "2 members · 1 agent",
  );
  assert.equal(memberSubtitle(memberSummary([])), "0 members");
});

test("an agent set keyed in lowercase matches an uppercase roster key", () => {
  const summary = memberSummary([NIKON.toUpperCase()], new Set([NIKON]));
  assert.equal(summary.agents, 1);
});

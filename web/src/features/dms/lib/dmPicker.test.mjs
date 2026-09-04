import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDmSuggestions,
  profileLabel,
  recipientLabel,
} from "./dmPicker.ts";

const SELF = "aa".repeat(32);
const CRASH = "bb".repeat(32); // agent
const NIKON = "cc".repeat(32); // agent + also a DM contact
const SAM = "dd".repeat(32); // human contact only
const STRANGER = "ee".repeat(32); // contact with no profile

const agents = [
  { pubkey: NIKON, name: "Lord Nikon" },
  { pubkey: CRASH, name: "Crash Override" },
];
const contacts = [SAM, NIKON, STRANGER, SELF];
const profiles = new Map([
  [SAM, { name: "sam", displayName: "Sam" }],
  [NIKON, { name: "nikon", displayName: "Lord Nikon" }],
]);

function build(overrides = {}) {
  return buildDmSuggestions({
    agents,
    contacts,
    profiles,
    selfPubkey: SELF,
    filter: "",
    ...overrides,
  });
}

test("buildDmSuggestions: agents first, then contacts, alphabetical in group", () => {
  // STRANGER has no profile, so its label is the truncated key
  // ("eeeeeeee…eeee"), which sorts before "Sam" — expected order reflects
  // the label sort, not the fixture declaration order.
  assert.deepEqual(
    build().map((s) => [s.label, s.sublabel]),
    [
      ["Crash Override", "Agent"],
      ["Lord Nikon", "Agent"],
      [profileLabel(STRANGER, profiles), "Contact"],
      ["Sam", "Contact"],
    ],
  );
});

test("buildDmSuggestions: self is never suggested from either source", () => {
  assert.equal(
    build().some((s) => s.pubkey === SELF),
    false,
  );
});

test("buildDmSuggestions: agent entry wins dedupe for a dual agent+contact pubkey", () => {
  const nikon = build().find((s) => s.pubkey === NIKON);
  assert.equal(nikon?.sublabel, "Agent");
});

test("buildDmSuggestions: filter matches label case-insensitively", () => {
  assert.deepEqual(
    build({ filter: "crash" }).map((s) => s.pubkey),
    [CRASH],
  );
  assert.deepEqual(
    build({ filter: "LORD" }).map((s) => s.pubkey),
    [NIKON],
  );
});

test("buildDmSuggestions: filter matches hex pubkey substring", () => {
  // STRANGER has no profile so its label is the truncated key; filter on a
  // mid-key hex run only SAM shares nothing of.
  assert.deepEqual(
    build({ filter: SAM.slice(4, 12) }).map((s) => s.pubkey),
    [SAM],
  );
});

test("buildDmSuggestions: whitespace-only filter returns everything", () => {
  assert.equal(build({ filter: "   " }).length, 4);
});

test("buildDmSuggestions: empty sources yield empty list, not a crash", () => {
  assert.deepEqual(
    buildDmSuggestions({
      agents: [],
      contacts: [],
      profiles,
      selfPubkey: SELF,
      filter: "",
    }),
    [],
  );
});

test("buildDmSuggestions: agent with no name falls back to profile label", () => {
  const list = buildDmSuggestions({
    agents: [{ pubkey: SAM, name: "" }],
    contacts: [],
    profiles,
    selfPubkey: SELF,
    filter: "",
  });
  assert.deepEqual(
    list.map((s) => [s.label, s.sublabel]),
    [["Sam", "Agent"]],
  );
});

test("profileLabel: displayName wins, then name, then truncated key", () => {
  assert.equal(profileLabel(SAM, profiles), "Sam");
  assert.equal(
    profileLabel(
      "ff".repeat(32),
      new Map([["ff".repeat(32), { name: "x", displayName: "" }]]),
    ),
    "x",
  );
  assert.match(
    profileLabel("ab".repeat(32), new Map()),
    /^[0-9a-f]+…[0-9a-f]+$/,
  );
});

test("recipientLabel: prefers a suggestion label, falls back to profile", () => {
  const suggestions = build({ filter: "crash" });
  assert.equal(recipientLabel(CRASH, suggestions, profiles), "Crash Override");
  assert.equal(recipientLabel(SAM, suggestions, profiles), "Sam");
});

test("buildDmSuggestions: stale agents are flagged and sort after live agents and contacts", () => {
  const list = build({
    stalePubkeys: new Set([CRASH]),
  });
  assert.deepEqual(
    list.map((s) => [s.label, s.sublabel, Boolean(s.stale)]),
    [
      ["Lord Nikon", "Agent", false],
      [profileLabel(STRANGER, profiles), "Contact", false],
      ["Sam", "Contact", false],
      ["Crash Override", "Agent", true],
    ],
  );
});

test("buildDmSuggestions: stale flag on a contact pubkey is inert (contacts never stale)", () => {
  const list = build({ stalePubkeys: new Set([SAM]) });
  const sam = list.find((s) => s.pubkey === SAM);
  assert.equal(sam?.sublabel, "Contact");
  assert.notEqual(sam?.stale, true);
});

test("buildDmSuggestions: duplicate-name keeper stays live, only older keys demote", () => {
  // Mirror of staleAgents.duplicatePubkeys semantics: the picker receives
  // the already-computed set; the keeper is absent from it.
  const OLD_ACID = "ff".repeat(32);
  const list = buildDmSuggestions({
    agents: [
      { pubkey: CRASH, name: "Acid Burn", updatedAt: 20 },
      { pubkey: OLD_ACID, name: "Acid Burn", updatedAt: 10 },
    ],
    contacts: [],
    profiles: new Map(),
    selfPubkey: SELF,
    filter: "",
    stalePubkeys: new Set([OLD_ACID]),
  });
  assert.deepEqual(
    list.map((s) => [s.label, s.pubkey, Boolean(s.stale)]),
    [
      ["Acid Burn", CRASH, false],
      ["Acid Burn", OLD_ACID, true],
    ],
  );
});

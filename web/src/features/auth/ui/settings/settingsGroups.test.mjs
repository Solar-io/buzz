import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SETTINGS_GROUP,
  SETTINGS_GROUPS,
  SETTINGS_GROUP_IDS,
  filterSettingsGroups,
  parseSettingsGroup,
  resolveSettingsGroup,
  visibleSettingsGroups,
} from "./settingsGroups.ts";

test("the IA has exactly the thirteen W6 groups, in nav order", () => {
  assert.deepEqual(
    SETTINGS_GROUPS.map((group) => group.id),
    [
      "agents",
      "accounts",
      "library",
      "account",
      "voice",
      "notifications",
      "appearance",
      "keyboard",
      "community",
      "channels",
      "data",
      "security",
      "advanced",
    ],
  );
  assert.equal(SETTINGS_GROUP_IDS.length, SETTINGS_GROUPS.length);
});

test("every group carries a nav label, a name, and a description", () => {
  for (const group of SETTINGS_GROUPS) {
    assert.ok(group.navLabel.length > 0, `${group.id} needs a navLabel`);
    assert.ok(group.name.length > 0, `${group.id} needs a name`);
    assert.ok(group.description.length > 0, `${group.id} needs a description`);
  }
});

test("nav labels appear in contiguous runs, matching the mock's four sections", () => {
  const runs = [];
  for (const group of SETTINGS_GROUPS) {
    if (runs.length === 0 || runs[runs.length - 1] !== group.navLabel) {
      runs.push(group.navLabel);
    }
  }
  assert.deepEqual(runs, ["Agents", "You", "Community", "Data & security"]);
});

test("keyboard is the only group hidden on phones", () => {
  const hidden = SETTINGS_GROUPS.filter((group) => group.hiddenOnPhone);
  assert.deepEqual(
    hidden.map((group) => group.id),
    ["keyboard"],
  );
});

test("visibleSettingsGroups keeps agents on iOS and hides only keyboard on phones", () => {
  const web = visibleSettingsGroups(false).map((group) => group.id);
  const ios = visibleSettingsGroups(true).map((group) => group.id);
  assert.deepEqual(web, [...SETTINGS_GROUP_IDS]);
  assert.deepEqual(
    ios,
    web.filter((id) => id !== "keyboard"),
  );
});

test("parseSettingsGroup accepts known ids and rejects everything else", () => {
  assert.equal(parseSettingsGroup("security"), "security");
  assert.equal(parseSettingsGroup("account"), "account");
  // Unknown, wrong case, non-string, and absent all fall through.
  assert.equal(parseSettingsGroup("Security"), undefined);
  assert.equal(parseSettingsGroup("nope"), undefined);
  assert.equal(parseSettingsGroup(42), undefined);
  assert.equal(parseSettingsGroup(null), undefined);
  assert.equal(parseSettingsGroup(undefined), undefined);
});

test("resolveSettingsGroup defaults to account for anything unparsable", () => {
  assert.equal(resolveSettingsGroup("advanced"), "advanced");
  assert.equal(resolveSettingsGroup(undefined), DEFAULT_SETTINGS_GROUP);
  assert.equal(resolveSettingsGroup("SECURITY"), DEFAULT_SETTINGS_GROUP);
  assert.equal(DEFAULT_SETTINGS_GROUP, "account");
});

test("an empty query returns every group in order", () => {
  assert.deepEqual(
    filterSettingsGroups("").map((group) => group.id),
    [...SETTINGS_GROUP_IDS],
  );
  assert.deepEqual(
    filterSettingsGroups("   ").map((group) => group.id),
    [...SETTINGS_GROUP_IDS],
  );
});

test("filter is case-insensitive over names", () => {
  assert.deepEqual(
    filterSettingsGroups("shortcuts").map((group) => group.id),
    ["keyboard"],
  );
  assert.deepEqual(
    filterSettingsGroups("KEYBOARD").map((group) => group.id),
    ["keyboard"],
  );
});

test("filter matches section labels, so a label query returns its run", () => {
  assert.deepEqual(
    filterSettingsGroups("security").map((group) => group.id),
    ["data", "security", "advanced"],
  );
  // "community" is both a label and a name; its run is community + agents.
  assert.deepEqual(
    filterSettingsGroups("community").map((group) => group.id),
    ["community", "channels"],
  );
});

test("filter matches descriptions, so a setting's word finds its group", () => {
  assert.deepEqual(
    filterSettingsGroups("pairing").map((group) => group.id),
    ["security"],
  );
  assert.deepEqual(
    filterSettingsGroups("emoji").map((group) => group.id),
    ["community"],
  );
  // Substring, not word-boundary: "you" (a label) also lands inside the
  // security description's "Your key…" — accepted, because the point of the
  // filter is to be one dumb substring match, not a search engine.
  assert.ok(
    filterSettingsGroups("you")
      .map((group) => group.id)
      .includes("security"),
  );
});

test("filter narrows further with longer queries", () => {
  assert.deepEqual(
    filterSettingsGroups("security dev").map((group) => group.id),
    [],
  );
  assert.deepEqual(filterSettingsGroups("zzz"), []);
});

test("owners land on Agents while explicit Account links keep their target", () => {
  assert.equal(resolveSettingsGroup(undefined, { ownsAgents: true }), "agents");
  assert.equal(
    resolveSettingsGroup("nonsense", { ownsAgents: true }),
    "agents",
  );
  assert.equal(
    resolveSettingsGroup("account", { ownsAgents: true }),
    "account",
  );
  assert.equal(
    resolveSettingsGroup(undefined, { ownsAgents: false }),
    "account",
  );
});
test("settings search finds the Agents group through an agent name", () => {
  assert.deepEqual(
    filterSettingsGroups(" GiLf ", SETTINGS_GROUPS, [
      { name: "Gilfoyle", pubkey: "a".repeat(64) },
    ]).map((group) => group.id),
    ["agents"],
  );
});

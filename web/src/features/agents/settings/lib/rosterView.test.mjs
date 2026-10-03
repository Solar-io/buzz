import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoster } from "../../lib/roster.ts";
import { findStaleAgents } from "../../lib/staleAgents.ts";
import {
  buildRosterView,
  filterRoster,
  rosterColumns,
  rosterCounts,
  rosterWorking,
} from "./rosterView.ts";
import { rosterSnapshot } from "./rosterSnapshot.ts";

const entry = (key, name = key) => ({
  pubkey: key,
  name,
  model: "opus",
  provider: "",
  systemPrompt: "Instructions",
  personaId: null,
  updatedAt: 1,
  parallelism: null,
  respondTo: "owner-only",
  respondToAllowlist: [],
  effort: null,
});
const catalog = {
  machine: "crichton.local",
  version: 4,
  agents: ["a"],
  updatedAt: 1000,
  harnesses: [],
};
const frames = (kind, createdAt = 990, channelId = "channel", seq = 1) => ({
  kind,
  createdAt,
  seq,
  channelId,
});
const rows = () =>
  buildRosterView(
    buildRoster([entry("a"), entry("b")], new Map(), [catalog]),
    [catalog],
    new Map(),
    new Map([["a", [frames("turn_started")]]]),
    1000,
  );

test("Not on any desktop equals the findStaleAgents set", () => {
  const entries = [entry("a", "Twin"), entry("b", "Twin"), entry("c", "Other")];
  const catalogs = [{ ...catalog, agents: ["a", "b"] }];
  const view = buildRosterView(
    buildRoster(entries, new Map(), catalogs),
    catalogs,
    new Map(),
  );
  assert.deepEqual(
    filterRoster(view, "Not on any desktop", "", "")
      .map((row) => row.pubkey)
      .sort(),
    findStaleAgents(entries, catalogs)
      .map((row) => row.pubkey)
      .sort(),
  );
  assert.equal(rosterCounts(view)["Not on any desktop"], 2);
});
test("width 1000 drops Runtime and Acct", () => {
  assert.deepEqual(rosterColumns(1000), [
    "Agent",
    "Status",
    "Model",
    "Effort",
    "Voice turns",
  ]);
  assert.deepEqual(rosterColumns(1099), [
    "Agent",
    "Status",
    "Model",
    "Effort",
    "Voice turns",
  ]);
  assert.deepEqual(rosterColumns(1100), [
    "Agent",
    "Status",
    "Model",
    "Effort",
    "Voice turns",
    "Runtime",
    "Acct",
  ]);
});
test("content width 767 renders phone columns, 768 renders a table", () => {
  assert.deepEqual(rosterColumns(390), ["Agent", "Status", "Model"]);
  assert.deepEqual(rosterColumns(767), ["Agent", "Status", "Model"]);
  assert.equal(rosterColumns(768).length, 5);
});
test("chip counts use observer Working and historical Claimed without inventing process state", () => {
  assert.deepEqual(rosterCounts(rows()), {
    All: 2,
    Working: 1,
    Claimed: 0,
    "Not on any desktop": 1,
  });
  const inactive = rows().map((row) => ({
    ...row,
    status: row.machines.length ? "Claimed" : row.status,
  }));
  assert.equal(rosterCounts(inactive).Claimed, 1);
  assert.deepEqual(Object.keys(rosterCounts(inactive)), [
    "All",
    "Working",
    "Claimed",
    "Not on any desktop",
  ]);
});
test("team and name/model filters compose with status and preserve input", () => {
  const view = rows().map((row) => ({
    ...row,
    teams: row.pubkey === "a" ? ["Platform", "Devices"] : ["Platform2"],
  }));
  assert.equal(filterRoster(view, "Working", "Devices", " OPUS ").length, 1);
  assert.equal(filterRoster(view, "All", "Platform", "b").length, 0);
  assert.equal(
    filterRoster(view, "Not on any desktop", "Platform2", "b")[0].pubkey,
    "b",
  );
  assert.equal(view.length, 2);
});
test("linked agents show effective team and model without dropping standalone rows", () => {
  const persona = {
    id: "definition",
    name: "Effective name",
    model: "sol",
    provider: "",
    systemPrompt: "Prompt",
  };
  const view = buildRosterView(
    buildRoster(
      [{ ...entry("a"), personaId: persona.id }, entry("b")],
      new Map([[persona.id, persona]]),
      [catalog],
    ),
    [catalog],
    new Map([[persona.id, ["Platform", "Devices"]]]),
  );
  assert.equal(view.length, 2);
  const linked = view.find((row) => row.pubkey === "a");
  assert.equal(linked.name, "Effective name");
  assert.equal(linked.model, "sol");
  assert.deepEqual(linked.teams, ["Platform", "Devices"]);
});
test("terminal frames end Working; another active channel remains Working", () => {
  assert.equal(
    rosterWorking(
      [frames("turn_started"), frames("turn_completed", 990, "channel", 2)],
      1000,
    ),
    false,
  );
  assert.equal(rosterWorking([frames("turn_error")], 1000), false);
  assert.equal(rosterWorking([frames("agent_panic")], 1000), false);
  assert.equal(
    rosterWorking(
      [frames("turn_completed"), frames("acp_read", 991, "other")],
      1000,
    ),
    true,
  );
  assert.equal(rosterWorking([frames("acp_read", 819)], 1000), false);
});
test("an empty catalog never turns all registrations into cleanup candidates", () => {
  const catalogs = [{ ...catalog, agents: [] }];
  const view = buildRosterView(
    buildRoster([entry("a")], new Map(), catalogs),
    catalogs,
    new Map(),
  );
  assert.equal(filterRoster(view, "Not on any desktop", "", "").length, 0);
});
test("standalone snapshot exports readable fields and identity without inventing a runtime", () => {
  const row = buildRoster([entry("a", "Throwaway")], new Map(), [catalog])[0];
  const persona = rosterSnapshot(row, {
    avatar: "https://relay.test/media/avatar",
  });
  const content = JSON.parse(persona.event.content);
  assert.equal(content.display_name, "Throwaway");
  assert.equal(content.model, "opus");
  assert.equal(content.system_prompt, "Instructions");
  assert.equal(content.runtime, undefined);
  assert.equal(content.parallelism, undefined);
  assert.equal(content.avatar_url, "https://relay.test/media/avatar");
  assert.equal(content.respond_to, "owner-only");
});

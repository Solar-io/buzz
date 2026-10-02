import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettingsSearch, filterSettingsAgents } from "./settingsGroups.ts";

test("settings route validates agent targets and known tabs", () => {
  assert.deepEqual(
    parseSettingsSearch({
      group: "agents",
      agent: "A".repeat(64),
      tab: "channels",
      extra: "ignore",
    }),
    { group: "agents", agent: "a".repeat(64), tab: "channels" },
  );
  assert.deepEqual(
    parseSettingsSearch({ group: "oops", agent: "<script>", tab: "oops" }),
    {},
  );
  for (const agent of [12, null, "a".repeat(63), "g".repeat(64)])
    assert.deepEqual(parseSettingsSearch({ agent }), {});
});
test("agent name search ignores case and whitespace but does not match pubkeys", () => {
  const agents = [
    { pubkey: "a".repeat(64), name: "Gilfoyle" },
    { pubkey: "b".repeat(64), name: "Evie" },
  ];
  assert.deepEqual(filterSettingsAgents(" GiLf ", agents), [agents[0]]);
  assert.deepEqual(filterSettingsAgents("", agents), []);
  assert.deepEqual(filterSettingsAgents("aaaa", agents), []);
});

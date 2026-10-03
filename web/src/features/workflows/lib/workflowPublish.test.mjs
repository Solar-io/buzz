import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEW_WORKFLOW_YAML,
  workflowEventTemplate,
  workflowYamlError,
} from "./workflowPublish.ts";
import { workflowFromEvent } from "./workflowDefinition.ts";

const original = workflowFromEvent({
  id: "ab".repeat(32),
  pubkey: "owner",
  kind: 30620,
  created_at: 12,
  tags: [
    ["d", "8b399734-2a08-4670-9474-0929d9f55f9c"],
    ["h", "channel"],
  ],
  content: NEW_WORKFLOW_YAML,
});

test("create uses a fresh UUID, channel tag and verbatim YAML", () => {
  const event = workflowEventTemplate("channel", NEW_WORKFLOW_YAML);
  assert.equal(event.kind, 30620);
  assert.match(event.tags[0][1], /^[a-f0-9-]{36}$/);
  assert.deepEqual(event.tags[1], ["h", "channel"]);
  assert.equal(event.tags.length, 2);
  assert.equal(event.content, NEW_WORKFLOW_YAML);
  assert.notEqual(
    workflowEventTemplate("channel", NEW_WORKFLOW_YAML).tags[0][1],
    event.tags[0][1],
  );
});
test("edit keeps the same d tag and guards the original revision", () => {
  const yaml = NEW_WORKFLOW_YAML.replace("New workflow", "Edited workflow");
  const event = workflowEventTemplate("channel", yaml, original);
  assert.deepEqual(event.tags, [
    ["d", "8b399734-2a08-4670-9474-0929d9f55f9c"],
    ["h", "channel"],
    ["expected-revision", "ab".repeat(32)],
  ]);
  assert.equal(event.content, yaml);
});
test("new draft retries retain the same workflow identity", () => {
  const draftId = "9dff4131-8d83-4faf-9fb9-518421839c1a";
  assert.deepEqual(
    workflowEventTemplate("channel", NEW_WORKFLOW_YAML, undefined, draftId)
      .tags[0],
    ["d", draftId],
  );
});
test("edit refuses moving a workflow into another channel", () => {
  assert.throws(
    () => workflowEventTemplate("other", NEW_WORKFLOW_YAML, original),
    /another channel/,
  );
});
test("invalid YAML cannot produce a publish template", () => {
  assert.throws(
    () =>
      workflowEventTemplate("channel", "name: Broken\ntrigger:\n  on: [bad\n"),
    /line 3/,
  );
});
test("syntax errors include the offending line", () => {
  for (const [yaml, line] of [
    ['name: "Broken\n', 1],
    ["name: Test\ntrigger:\n  \ton: webhook", 3],
    ["name: Test\nname: Other", 2],
    ["name: Test\n---\nname: Other", 2],
  ]) {
    assert.match(workflowYamlError(yaml), new RegExp(`line ${line}\\b`));
  }
});
test("local shape validation requires name, trigger and steps", () => {
  assert.match(workflowYamlError(""), /mapping/);
  assert.match(workflowYamlError("name: ''"), /name/);
  assert.match(workflowYamlError("name: Test"), /trigger/);
  assert.match(
    workflowYamlError("name: Test\ntrigger:\n  on: webhook\nsteps: []"),
    /step/,
  );
  assert.equal(workflowYamlError(NEW_WORKFLOW_YAML), null);
});
test("workflow size is bounded by UTF-8 bytes, not string length", () => {
  assert.match(
    workflowYamlError(`${NEW_WORKFLOW_YAML}description: ${"é".repeat(32768)}`),
    /64 KB/,
  );
});
test("an authored prototype key is plain YAML data", () => {
  assert.match(
    workflowYamlError(
      "__proto__:\n  name: hidden\n  trigger:\n    on: webhook\n  steps: []",
    ),
    /needs a name/,
  );
});

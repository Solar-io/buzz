import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canTrigger,
  KIND_WORKFLOW_TRIGGER,
  runIdFromRelayMessage,
  triggerEventTemplate,
} from "./workflowTrigger.ts";

const WORKFLOW_ID = "4f1c8b6a-2d31-4a55-9c0e-7b8d5e2f1a90";
const OWNER = "ab".repeat(32);
const STRANGER = "cd".repeat(32);

test("builds the trigger event the relay reads", () => {
  // build_workflow_trigger in crates/buzz-sdk/src/builders.rs: kind 46020,
  // d tag = workflow uuid, empty content.
  const template = triggerEventTemplate(WORKFLOW_ID);
  assert.equal(template.kind, KIND_WORKFLOW_TRIGGER);
  assert.equal(template.kind, 46020);
  assert.deepEqual(template.tags, [["d", WORKFLOW_ID]]);
  assert.equal(template.content, "");
});

test("carries inputs as a JSON object, as `buzz --inputs` does", () => {
  const template = triggerEventTemplate(WORKFLOW_ID, { reason: "manual run" });
  assert.equal(template.content, '{"reason":"manual run"}');
});

test("refuses a workflow id that is not a UUID", () => {
  assert.throws(() => triggerEventTemplate("nope"), /UUID/);
  assert.throws(() => triggerEventTemplate(""), /UUID/);
});

test("reads the run id out of the relay's prefixed OK message", () => {
  assert.equal(
    runIdFromRelayMessage(
      'response:{"run_id":"33333333-3333-4333-8333-333333333333"}',
    ),
    "33333333-3333-4333-8333-333333333333",
  );
});

test("accepts a bare JSON body, as Desktop's parser does", () => {
  assert.equal(runIdFromRelayMessage('{"run_id":"abc"}'), "abc");
});

test("returns null rather than inventing a run id", () => {
  assert.equal(runIdFromRelayMessage("duplicate: already processed"), null);
  assert.equal(runIdFromRelayMessage("response:{}"), null);
  assert.equal(runIdFromRelayMessage("response:[]"), null);
  assert.equal(runIdFromRelayMessage('response:{"run_id":""}'), null);
  assert.equal(runIdFromRelayMessage(""), null);
});

test("offers the run button only where the relay would accept it", () => {
  // handle_workflow_trigger: owner only, and only while enabled and active.
  assert.equal(canTrigger(OWNER, true, OWNER), true);
  assert.equal(canTrigger(OWNER, false, OWNER), false, "disabled is refused");
  assert.equal(
    canTrigger(OWNER, true, STRANGER),
    false,
    "non-owner is refused",
  );
  assert.equal(canTrigger(OWNER, true, null), false, "signed out cannot run");
  assert.equal(
    canTrigger(OWNER.toUpperCase(), true, OWNER),
    true,
    "pubkey case must not decide ownership",
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionLabel,
  mergeWorkflow,
  triggerDescription,
  triggerLabel,
  workflowFromEvent,
} from "./workflowDefinition.ts";

const WORKFLOW_ID = "4f1c8b6a-2d31-4a55-9c0e-7b8d5e2f1a90";
const CHANNEL_ID = "9a2e7c14-6b3f-4d28-b1c7-3e5a9f0d2b41";
const OWNER = "ab".repeat(32);

function event(overrides = {}) {
  return {
    id: "cd".repeat(32),
    pubkey: OWNER,
    kind: 30620,
    created_at: 1_700_000_000,
    tags: [
      ["d", WORKFLOW_ID],
      ["h", CHANNEL_ID],
    ],
    // Verbatim from crates/buzz-workflow/src/schema.rs —
    // parse_simple_message_posted_workflow.
    content:
      "name: 'Incident Alert'\ndescription: 'Alert on P1 messages'\ntrigger:\n  on: message_posted\n  filter: 'str_contains(trigger_text, \"P1\")'\nsteps:\n  - id: notify\n    action: send_message\n    text: 'P1 alert'\n",
    ...overrides,
  };
}

test("reads id, channel, owner and revision off the event, not the body", () => {
  const workflow = workflowFromEvent(event());
  assert.equal(workflow.id, WORKFLOW_ID, "id comes from the d tag");
  assert.equal(workflow.channelId, CHANNEL_ID, "channel comes from the h tag");
  assert.equal(workflow.ownerPubkey, OWNER);
  assert.equal(workflow.revision, "cd".repeat(32), "revision is the event id");
  assert.equal(workflow.updatedAt, 1_700_000_000);
});

test("reads the definition body the engine's own fixture describes", () => {
  const workflow = workflowFromEvent(event());
  assert.equal(workflow.name, "Incident Alert");
  assert.equal(workflow.description, "Alert on P1 messages");
  assert.equal(workflow.trigger.on, "message_posted");
  assert.equal(workflow.trigger.filter, 'str_contains(trigger_text, "P1")');
  assert.equal(workflow.steps.length, 1);
  assert.equal(workflow.steps[0].id, "notify");
  assert.equal(workflow.steps[0].action, "send_message");
  assert.deepEqual(workflow.steps[0].fields, [
    { key: "text", value: "P1 alert" },
  ]);
  assert.equal(workflow.parseError, null);
});

test("an absent `enabled` key means enabled, per the schema default", () => {
  // schema.rs: `#[serde(default = "default_true")] pub enabled: bool`.
  assert.equal(workflowFromEvent(event()).enabled, true);
});

test("`enabled: false` disables; any other value does not", () => {
  const disabled = workflowFromEvent(
    event({ content: "name: Off\nenabled: false\n" }),
  );
  assert.equal(disabled.enabled, false);
  const explicit = workflowFromEvent(
    event({ content: "name: On\nenabled: true\n" }),
  );
  assert.equal(explicit.enabled, true);
});

test("names the workflow by its id when the body has no name", () => {
  const workflow = workflowFromEvent(
    event({ content: "trigger:\n  on: webhook\n" }),
  );
  assert.equal(workflow.name, WORKFLOW_ID);
});

test("an unreadable body yields a parse error, not a silent blank", () => {
  const workflow = workflowFromEvent(
    event({ content: "steps:\n  - id: a\n   action: send_message\n" }),
  );
  assert.ok(workflow, "an unreadable body must still produce a listable row");
  assert.ok(workflow.parseError, "the reason must reach the UI");
  assert.equal(workflow.steps.length, 0);
  assert.equal(
    workflow.yaml,
    "steps:\n  - id: a\n   action: send_message\n",
    "the raw body must survive so it can still be shown",
  );
});

test("an empty body is not treated as unreadable", () => {
  const workflow = workflowFromEvent(event({ content: "" }));
  assert.equal(workflow.parseError, null);
  assert.equal(workflow.steps.length, 0);
});

test("rejects an event that is not a workflow definition", () => {
  assert.equal(workflowFromEvent(event({ kind: 30177 })), null);
});

test("rejects a definition with no d tag — it cannot be addressed", () => {
  assert.equal(workflowFromEvent(event({ tags: [["h", CHANNEL_ID]] })), null);
});

test("keeps the newer revision when the relay replays both", () => {
  const older = workflowFromEvent(event());
  const newer = workflowFromEvent(
    event({
      id: "ef".repeat(32),
      created_at: 1_700_000_500,
      content: "name: Renamed\n",
    }),
  );
  const afterNewer = mergeWorkflow(new Map(), newer);
  assert.equal(
    mergeWorkflow(afterNewer, older).get(WORKFLOW_ID).name,
    "Renamed",
    "an older replay must not overwrite the newer revision",
  );
  assert.equal(
    mergeWorkflow(mergeWorkflow(new Map(), older), newer).get(WORKFLOW_ID).name,
    "Renamed",
  );
});

test("merging an identical revision does not churn the map", () => {
  const workflow = workflowFromEvent(event());
  const first = mergeWorkflow(new Map(), workflow);
  assert.equal(mergeWorkflow(first, workflow), first);
});

test("gives repeated step ids distinct render keys", () => {
  // The relay rejects duplicate step ids, but a client renders whatever was
  // last saved — including a body that never passed validation — so two rows
  // sharing a key would collapse in React.
  const workflow = workflowFromEvent(
    event({
      content:
        "name: Duplicate IDs\n" +
        "trigger:\n  on: message_posted\n" +
        "steps:\n" +
        "  - id: step1\n    action: send_message\n    text: first\n" +
        "  - id: step1\n    action: send_message\n    text: second\n",
    }),
  );
  assert.equal(workflow.steps.length, 2);
  assert.equal(workflow.steps[0].key, "step1");
  assert.equal(workflow.steps[1].key, "step1#1");
  assert.equal(workflow.steps[0].id, "step1", "the id itself is not rewritten");
  assert.equal(workflow.steps[1].id, "step1");
});

test("names an id-less step by position", () => {
  const workflow = workflowFromEvent(
    event({ content: "steps:\n  - action: delay\n    duration: 5s\n" }),
  );
  assert.equal(workflow.steps[0].id, "step-1");
  assert.equal(workflow.steps[0].key, "step-1");
  assert.deepEqual(workflow.steps[0].fields, [
    { key: "duration", value: "5s" },
  ]);
});

test("labels every trigger and action the schema defines", () => {
  assert.equal(triggerLabel({ on: "message_posted" }), "Message posted");
  assert.equal(triggerLabel({ on: "reaction_added" }), "Reaction added");
  assert.equal(triggerLabel({ on: "diff_posted" }), "Diff posted");
  assert.equal(triggerLabel({ on: "schedule" }), "On a schedule");
  assert.equal(triggerLabel({ on: "webhook" }), "Webhook");
  assert.equal(triggerLabel({ on: null }), "No trigger");
  // An unknown value from a newer relay is shown, not swallowed.
  assert.equal(triggerLabel({ on: "future_thing" }), "Future thing");

  assert.equal(actionLabel("send_message"), "Send a message");
  assert.equal(actionLabel("send_dm"), "Send a DM");
  assert.equal(actionLabel("set_channel_topic"), "Set the channel topic");
  assert.equal(actionLabel("add_reaction"), "Add a reaction");
  assert.equal(actionLabel("call_webhook"), "Call a webhook");
  assert.equal(actionLabel("request_approval"), "Request approval");
  assert.equal(actionLabel("delay"), "Wait");
  assert.equal(actionLabel(null), "No action");
});

test("describes a schedule trigger by its cron, and a filter by its expression", () => {
  assert.equal(
    triggerDescription({
      on: "schedule",
      cron: "0 9 * * 1-5",
      interval: null,
      emoji: null,
      filter: null,
    }),
    "On a schedule — cron 0 9 * * 1-5",
  );
  assert.equal(
    triggerDescription({
      on: "schedule",
      cron: null,
      interval: "30m",
      emoji: null,
      filter: null,
    }),
    "On a schedule — every 30m",
  );
  assert.equal(
    triggerDescription({
      on: "reaction_added",
      emoji: "clipboard",
      filter: 'trigger_message_id == "abc123"',
      cron: null,
      interval: null,
    }),
    'Reaction added — :clipboard:, when trigger_message_id == "abc123"',
  );
  assert.equal(
    triggerDescription({
      on: "webhook",
      emoji: null,
      filter: null,
      cron: null,
      interval: null,
    }),
    "Webhook",
  );
});

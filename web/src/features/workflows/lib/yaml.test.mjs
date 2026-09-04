import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findKeySeparator,
  parseYamlDocument,
  parseYamlMapping,
  resolvePlainScalar,
  stripComment,
} from "./yaml.ts";

/**
 * The fixtures below are copied VERBATIM out of the engine's own tests in
 * `crates/buzz-workflow/src/schema.rs`, and each assertion mirrors what that
 * Rust test asserts about the parsed `WorkflowDef`. The shape under test is
 * therefore the engine's, not this parser's: `serde` flattens both the trigger
 * and the action enums, so `on:` and `action:` sit alongside their sibling
 * fields rather than nesting.
 */

test("parses the engine's simple message_posted fixture", () => {
  // schema.rs — parse_simple_message_posted_workflow
  const yaml =
    "name: 'Incident Alert'\ndescription: 'Alert on P1 messages'\ntrigger:\n  on: message_posted\n  filter: 'str_contains(trigger_text, \"P1\")'\nsteps:\n  - id: notify\n    action: send_message\n    text: 'P1 alert'\n";
  const doc = parseYamlMapping(yaml);
  assert.deepEqual(doc, {
    name: "Incident Alert",
    description: "Alert on P1 messages",
    trigger: {
      on: "message_posted",
      filter: 'str_contains(trigger_text, "P1")',
    },
    steps: [{ id: "notify", action: "send_message", text: "P1 alert" }],
  });
  // The Rust asserts `def.enabled` is true by default — the key is absent, and
  // absence is what the reader must report so the default can be applied.
  assert.equal("enabled" in doc, false);
});

test("parses the engine's reaction_added fixture", () => {
  // schema.rs — parse_reaction_added_trigger
  const yaml =
    "name: Triage\ntrigger:\n  on: reaction_added\n  emoji: clipboard\n  filter: 'trigger_message_id == \"abc123\"'\nsteps:\n  - id: ack\n    action: add_reaction\n    emoji: eyes\n";
  const doc = parseYamlMapping(yaml);
  assert.deepEqual(doc.trigger, {
    on: "reaction_added",
    emoji: "clipboard",
    filter: 'trigger_message_id == "abc123"',
  });
  assert.deepEqual(doc.steps, [
    { id: "ack", action: "add_reaction", emoji: "eyes" },
  ]);
});

test("parses the engine's schedule fixture without mangling the cron", () => {
  // schema.rs — parse_schedule_trigger
  const yaml =
    "name: Daily Standup\ntrigger:\n  on: schedule\n  cron: '0 9 * * 1-5'\nsteps:\n  - id: prompt\n    action: send_message\n    text: Standup time\n";
  const doc = parseYamlMapping(yaml);
  assert.deepEqual(doc.trigger, { on: "schedule", cron: "0 9 * * 1-5" });
  assert.equal(doc.steps[0].text, "Standup time");
});

test("reads an explicit boolean step field", () => {
  // schema.rs — reply_in_thread_defaults_false_and_round_trips
  const withFlag = parseYamlMapping(
    "name: Auto Reply\ntrigger:\n  on: message_posted\nsteps:\n  - id: s1\n    action: send_message\n    text: hi\n    reply_in_thread: true\n",
  );
  assert.equal(withFlag.steps[0].reply_in_thread, true);

  const withoutFlag = parseYamlMapping(
    "name: Auto Reply\ntrigger:\n  on: message_posted\nsteps:\n  - id: s1\n    action: send_message\n    text: hi\n",
  );
  assert.equal("reply_in_thread" in withoutFlag.steps[0], false);
});

test("reads an empty flow sequence as an empty steps list", () => {
  // schema.rs — validate_rejects_empty_steps: `steps: []` must reach the caller
  // as an empty array so the UI can say "no steps", not as a string.
  const doc = parseYamlMapping(
    "name: No Steps\ntrigger:\n  on: message_posted\nsteps: []\n",
  );
  assert.deepEqual(doc.steps, []);
});

test("reads an empty single-quoted name as an empty string", () => {
  // schema.rs — validate_rejects_empty_name
  const doc = parseYamlMapping(
    "name: ''\ntrigger:\n  on: message_posted\nsteps:\n  - id: s1\n    action: send_message\n    text: hi\n",
  );
  assert.equal(doc.name, "");
});

test("keeps both steps when ids repeat", () => {
  // schema.rs — validate_rejects_duplicate_step_ids: the engine rejects this,
  // but the reader must still surface both entries so the UI can show why.
  const doc = parseYamlMapping(
    "name: Duplicate IDs\n" +
      "trigger:\n  on: message_posted\n" +
      "steps:\n" +
      "  - id: step1\n    action: send_message\n    text: first\n" +
      "  - id: step1\n    action: send_message\n    text: second\n",
  );
  assert.equal(doc.steps.length, 2);
  assert.equal(doc.steps[0].text, "first");
  assert.equal(doc.steps[1].text, "second");
});

test("parses the ARCHITECTURE.md worked example", () => {
  const yaml = [
    'name: "Incident Triage"',
    "trigger:",
    "  on: message_posted",
    "  filter: \"str_contains(trigger_text, 'P1')\"",
    "steps:",
    "  - id: notify",
    "    action: send_message",
    '    text: "P1 incident detected: {{trigger.text}}"',
    "  - id: page",
    "    if: \"str_contains(trigger_text, 'production')\"",
    "    action: request_approval",
    '    from: "{{trigger.author}}"',
    '    message: "Page on-call?"',
    "",
  ].join("\n");
  const doc = parseYamlMapping(yaml);
  assert.equal(doc.name, "Incident Triage");
  assert.equal(doc.trigger.filter, "str_contains(trigger_text, 'P1')");
  assert.equal(doc.steps.length, 2);
  // A `:` inside a double-quoted value must not split the key.
  assert.equal(doc.steps[0].text, "P1 incident detected: {{trigger.text}}");
  assert.equal(doc.steps[1].if, "str_contains(trigger_text, 'production')");
  assert.equal(doc.steps[1].action, "request_approval");
});

test("reads a literal block scalar with its newlines intact", () => {
  const doc = parseYamlMapping(
    ["steps:", "  - id: s1", "    text: |", "      one", "      two", ""].join(
      "\n",
    ),
  );
  assert.equal(doc.steps[0].text, "one\ntwo\n");
});

test("strips the trailing newline of a `|-` block scalar", () => {
  const doc = parseYamlMapping(["text: |-", "  one", "  two", ""].join("\n"));
  assert.equal(doc.text, "one\ntwo");
});

test("folds a `>-` block scalar into one line", () => {
  const doc = parseYamlMapping(
    ["text: >-", "  one", "  two", "", "  four", ""].join("\n"),
  );
  assert.equal(doc.text, "one two\nfour");
});

test("folds a quoted scalar that wraps onto the next line", () => {
  // What the `yaml` writer emits once a value exceeds its line width.
  const doc = parseYamlMapping(
    ['text: "a long value', '  that wrapped"', ""].join("\n"),
  );
  assert.equal(doc.text, "a long value that wrapped");
});

test("folds a plain scalar that wraps onto the next line", () => {
  const doc = parseYamlMapping(
    ["name: a long name", "  that wrapped", "enabled: false", ""].join("\n"),
  );
  assert.equal(doc.name, "a long name that wrapped");
  assert.equal(doc.enabled, false);
});

test("keeps a `#` that sits inside a quoted value", () => {
  const doc = parseYamlMapping(
    ["text: 'ping #ops now' # notify", "emoji: eyes", ""].join("\n"),
  );
  assert.equal(doc.text, "ping #ops now");
  assert.equal(doc.emoji, "eyes");
});

test("unescapes a double-quoted string", () => {
  const doc = parseYamlMapping('text: "line\\none\\ttab \\"q\\" \\u00e9"\n');
  assert.equal(doc.text, 'line\none\ttab "q" é');
});

test("collapses a doubled single quote", () => {
  const doc = parseYamlMapping("text: 'it''s here'\n");
  assert.equal(doc.text, "it's here");
});

test("reports an error instead of guessing at an unreadable document", () => {
  // Misaligned continuation of a sequence item — PyYAML raises ParserError on
  // this same input, so reporting a reason (rather than a plausible mapping)
  // is the behaviour that matches a real YAML reader.
  const bad = "steps:\n  - id: a\n   action: send_message\n";
  const result = parseYamlDocument(bad);
  assert.equal(result.value, null);
  assert.ok(result.error, "an unreadable document must carry a reason");
  assert.equal(parseYamlMapping(bad), null);
});

test("reports an error for an anchor rather than inventing a value", () => {
  const result = parseYamlDocument("name: &anchor thing\n");
  assert.equal(result.value, null);
  assert.match(result.error, /anchor/);
});

test("treats a bare sequence document as an array", () => {
  const result = parseYamlDocument("- one\n- two\n");
  assert.deepEqual(result.value, ["one", "two"]);
  assert.equal(parseYamlMapping("- one\n- two\n"), null);
});

test("skips document markers and comment-only lines", () => {
  const doc = parseYamlMapping(
    ["---", "# a comment", "name: Marked", "..."].join("\n"),
  );
  assert.deepEqual(doc, { name: "Marked" });
});

test("resolvePlainScalar keeps zero-padded values as strings", () => {
  assert.equal(resolvePlainScalar("0 9 * * 1-5"), "0 9 * * 1-5");
  assert.equal(resolvePlainScalar("007"), "007");
  assert.equal(resolvePlainScalar("30"), 30);
  assert.equal(resolvePlainScalar("1.5"), 1.5);
  assert.equal(resolvePlainScalar("true"), true);
  assert.equal(resolvePlainScalar("~"), null);
  assert.equal(resolvePlainScalar(""), null);
});

test("findKeySeparator ignores colons inside quotes and in URLs", () => {
  assert.equal(findKeySeparator("url: https://example.test/x"), 3);
  assert.equal(findKeySeparator("filter: 'a == \"b:c\"'"), 6);
  assert.equal(findKeySeparator("just a plain scalar"), -1);
  // A colon with no following space is not a separator (`https://`).
  assert.equal(findKeySeparator("https://example.test"), -1);
});

test("stripComment leaves quoted hashes alone", () => {
  assert.equal(stripComment("a: 'x #y'"), "a: 'x #y'");
  assert.equal(stripComment("a: x # y"), "a: x ");
  assert.equal(stripComment("#whole line"), "");
});

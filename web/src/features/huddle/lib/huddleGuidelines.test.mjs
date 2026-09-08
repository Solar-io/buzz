import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHuddleGuidelinesEvent,
  HUDDLE_GUIDELINES_KIND,
  voiceModeGuidelines,
} from "./huddleGuidelines.ts";

const EPH = "11111111-2222-3333-4444-555555555555";
const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/*
 * The expectations below are hardcoded from the desktop source, not derived
 * from the implementation under test: kind and tags from
 * desktop/src-tauri/src/events.rs:505-517, the text from
 * desktop/src-tauri/src/huddle/agents.rs:37-53. Any drift — a reworded
 * line, a swapped tag, a changed kind — fails here.
 */

test("the guidelines kind is 48106, hardcoded", () => {
  assert.equal(HUDDLE_GUIDELINES_KIND, 48106);
});

test("the event is kind 48106 with exactly one h tag, on the ephemeral channel", () => {
  const built = buildHuddleGuidelinesEvent({
    ephemeralChannelId: EPH,
    parentChannelId: PARENT,
  });
  assert.ok("event" in built);
  assert.equal(built.event.kind, 48106);
  // Exactly one tag, h, pointing at the EPHEMERAL channel — the parent id
  // never appears as a tag (desktop events.rs:509-517).
  assert.deepEqual(built.event.tags, [["h", EPH]]);
});

test("the guidelines text is the desktop's, verbatim", () => {
  const text = voiceModeGuidelines(PARENT);
  assert.equal(
    text,
    `You are in a live voice huddle. Its attached main channel is ${PARENT}; that is not the live huddle channel.
The channel UUID in the current \`[Context]\` block is the live huddle channel. Only messages sent with \`buzz messages send\` to that current Context channel are spoken aloud, in the order sent; everything else you produce is silent.
When a user addresses you, your FIRST tool call must send a brief spoken reply to the current Context channel, before any file read, search, or other tool call. The usual rule against bare acknowledgments does not apply here; the pickup is the feedback that you heard them.
Then work, sending each useful sentence as its own message the moment it is ready—a few sentences per answer, not a monologue.
Speak plainly without markdown; post code or long detail to the attached main channel instead.
If you are not addressed, stay silent.`,
  );
});

test("the parent channel id is the only interpolation", () => {
  const other = voiceModeGuidelines("ffffffff-0000-0000-0000-000000000000");
  assert.ok(
    other.startsWith(
      "You are in a live voice huddle. Its attached main channel is ffffffff-0000-0000-0000-000000000000;",
    ),
  );
  // The parent id appears exactly once; the rest of the text is untouched.
  assert.equal(
    other.split("ffffffff-0000-0000-0000-000000000000").length - 1,
    1,
  );
});

test("verbatim pins on the phrases a rewrite would break first", () => {
  const text = voiceModeGuidelines(PARENT);
  // The em dash survives verbatim replication (agents.rs:48: "ready—a few").
  assert.ok(text.includes("ready—a few sentences"));
  // The agent-side tool is named in backticks, exactly as the desktop does.
  assert.ok(text.includes("`buzz messages send`"));
  // The closing line is the desktop's, with its period.
  assert.ok(text.endsWith("If you are not addressed, stay silent."));
});

test("the builder refuses empty ids instead of planning a broken event", () => {
  assert.deepEqual(
    buildHuddleGuidelinesEvent({
      ephemeralChannelId: "",
      parentChannelId: PARENT,
    }),
    { error: "ephemeral channel id is required" },
  );
  assert.deepEqual(
    buildHuddleGuidelinesEvent({
      ephemeralChannelId: EPH,
      parentChannelId: "",
    }),
    { error: "parent channel id is required" },
  );
});

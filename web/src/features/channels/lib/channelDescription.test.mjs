import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelDescription,
  DEFAULT_CHANNEL_DESCRIPTION,
} from "./channelDescription.ts";

test("topic wins over about and purpose", () => {
  assert.equal(
    channelDescription({
      topic: "Ship the web client",
      about: "About text",
      purpose: "Purpose text",
    }),
    "Ship the web client",
  );
});

test("about is used when there is no topic", () => {
  assert.equal(
    channelDescription({ topic: "", about: "About text", purpose: "Purpose" }),
    "About text",
  );
});

test("purpose is the last resort", () => {
  assert.equal(
    channelDescription({ topic: null, about: "   ", purpose: "Purpose" }),
    "Purpose",
  );
});

test("only ONE detail field renders — never all three concatenated", () => {
  const result = channelDescription({
    topic: "T",
    about: "A",
    purpose: "P",
  });
  assert.equal(result.includes("A"), false);
  assert.equal(result.includes("P"), false);
});

test("archived leads the line", () => {
  assert.equal(
    channelDescription({ topic: "Ship it", archived: true }),
    "Archived. Ship it",
  );
});

test("a non-member of an open channel is told it is read-only", () => {
  assert.equal(
    channelDescription({ topic: "Ship it", isMember: false, isOpen: true }),
    "Read-only until you join this open channel. Ship it",
  );
});

test("a member is told nothing about joining", () => {
  assert.equal(
    channelDescription({ topic: "Ship it", isMember: true, isOpen: true }),
    "Ship it",
  );
});

test("an unknown membership does not flash a read-only warning", () => {
  // `isMember: undefined` is the state on every channel switch before the
  // roster lands. Treating it as "not a member" would blink the notice.
  assert.equal(
    channelDescription({ topic: "Ship it", isOpen: true }),
    "Ship it",
  );
});

test("a private channel never offers the join line", () => {
  assert.equal(
    channelDescription({ topic: "Ship it", isMember: false, isOpen: false }),
    "Ship it",
  );
});

test("both prefixes can apply, archived first", () => {
  assert.equal(
    channelDescription({
      topic: "Ship it",
      archived: true,
      isMember: false,
      isOpen: true,
    }),
    "Archived. Read-only until you join this open channel. Ship it",
  );
});

test("a channel with nothing to say falls back", () => {
  assert.equal(channelDescription({}), DEFAULT_CHANNEL_DESCRIPTION);
  assert.equal(
    channelDescription({ topic: "  ", about: "", purpose: null }),
    DEFAULT_CHANNEL_DESCRIPTION,
  );
});

test("the fallback does not swallow a prefix", () => {
  assert.equal(channelDescription({ archived: true }), "Archived.");
});

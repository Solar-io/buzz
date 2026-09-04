import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPIRATION_MAX_DAYS,
  EXPIRATION_MIN_DAYS,
  jitteredExpiration,
  pendingReminderTags,
  randomDTag,
  REMINDER_ALT_TEXT,
  reminderPlaintext,
  terminalReminderTags,
  transitionContent,
} from "./reminderEvents.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;

function tagValue(tags, name) {
  const found = tags.filter((tag) => tag[0] === name);
  return found.length === 1 ? found[0][1] : undefined;
}

test("pending tags carry exactly one not_before, as a decimal string", () => {
  const tags = pendingReminderTags("abc123", 1_770_000_000);
  assert.equal(tagValue(tags, "d"), "abc123");
  assert.equal(tagValue(tags, "not_before"), "1770000000");
  assert.equal(tagValue(tags, "alt"), REMINDER_ALT_TEXT);
});

test("pending tags carry NO expiration", () => {
  // NIP-ER: an expiration on a pending reminder can delete it before it is
  // ever due, and the relay rejects one at or below not_before outright.
  const tags = pendingReminderTags("abc123", 1_770_000_000);
  assert.equal(
    tags.some((tag) => tag[0] === "expiration"),
    false,
  );
});

test("terminal tags OMIT not_before and carry an expiration", () => {
  // The relay cannot read `status`, so dropping not_before is the only way to
  // stop it scheduling a completed reminder. Keeping it re-fires forever.
  const tags = terminalReminderTags("abc123", NOW + 30 * DAY);
  assert.equal(
    tags.some((tag) => tag[0] === "not_before"),
    false,
  );
  assert.equal(tagValue(tags, "d"), "abc123");
  assert.equal(tagValue(tags, "expiration"), String(NOW + 30 * DAY));
});

test("jitteredExpiration stays inside the 30-90 day window at both ends", () => {
  assert.equal(
    jitteredExpiration(NOW, () => 0),
    NOW + EXPIRATION_MIN_DAYS * DAY,
  );
  // 0.9999… is the largest value Math.random can return.
  assert.equal(
    jitteredExpiration(NOW, () => 0.999_999_999),
    NOW + EXPIRATION_MAX_DAYS * DAY,
  );
  assert.equal(
    jitteredExpiration(NOW, () => 0.5),
    NOW + 60 * DAY,
  );
});

test("jitteredExpiration is always well past a same-day not_before", () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999_999_999]) {
    assert.ok(jitteredExpiration(NOW, () => r) > NOW + DAY);
  }
});

test("reminderPlaintext round-trips through the content parser", () => {
  const content = {
    status: "pending",
    note: "follow up",
    target: {
      eventId: "e".repeat(64),
      channelId: "chan",
      preview: "hi",
      authorPubkey: "a".repeat(64),
    },
  };
  assert.deepEqual(JSON.parse(reminderPlaintext(content)), content);
});

test("reminderPlaintext drops absent fields rather than writing null", () => {
  const json = JSON.parse(
    reminderPlaintext({ status: "pending", note: "solo" }),
  );
  assert.deepEqual(json, { status: "pending", note: "solo" });
  assert.equal("target" in json, false);
});

test("transitionContent changes status and keeps target and note", () => {
  const before = {
    status: "pending",
    note: "keep me",
    target: {
      eventId: "e1",
      channelId: "c1",
      preview: "p",
      authorPubkey: "a1",
    },
  };
  const after = transitionContent(before, "done");
  assert.equal(after.status, "done");
  assert.equal(after.note, "keep me");
  assert.deepEqual(after.target, before.target);
  assert.equal(before.status, "pending", "the input is not mutated");
});

test("randomDTag is 32 lowercase hex characters — 128 bits", () => {
  // NIP-ER makes 128 bits a MUST; crypto.randomUUID() only has 122.
  const tag = randomDTag((array) => {
    for (let index = 0; index < array.length; index += 1) {
      array[index] = index;
    }
  });
  assert.equal(tag, "000102030405060708090a0b0c0d0e0f");
  assert.equal(tag.length, 32);
  assert.match(tag, /^[0-9a-f]{32}$/);
});

test("randomDTag pads a single-digit byte", () => {
  const tag = randomDTag((array) => array.fill(5));
  assert.equal(tag, "05".repeat(16));
});

test("randomDTag draws from the real CSPRNG by default and does not repeat", () => {
  const tags = new Set();
  for (let index = 0; index < 50; index += 1) {
    const tag = randomDTag();
    assert.match(tag, /^[0-9a-f]{32}$/);
    tags.add(tag);
  }
  assert.equal(tags.size, 50);
});

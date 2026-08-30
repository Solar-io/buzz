import assert from "node:assert/strict";
import { test } from "node:test";
import { channelFromEvent } from "./channelFromEvent.ts";

function event(overrides = {}) {
  return {
    kind: 39000,
    created_at: 1_787_800_000,
    tags: [
      ["d", "c3309d9d-3ee5-52c1-8309-e6738b177a19"],
      ["name", "general"],
      ["about", "General conversation"],
      ["public"],
    ],
    content: "",
    id: "x".repeat(64),
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    ...overrides,
  };
}

test("reads name/about from tags (not content)", () => {
  const channel = channelFromEvent(event({ content: '{"name":"wrong"}' }));
  assert.equal(channel.name, "general");
  assert.equal(channel.about, "General conversation");
  assert.equal(channel.id, "c3309d9d-3ee5-52c1-8309-e6738b177a19");
});

test("falls back to the d-tag id when no name tag", () => {
  const channel = channelFromEvent({
    ...event(),
    tags: [["d", "abc-123"]],
  });
  assert.equal(channel.name, "abc-123");
  assert.equal(channel.about, "");
});

test("returns null without a d tag", () => {
  assert.equal(channelFromEvent(event({ tags: [["name", "x"]] })), null);
});

test("later event for the same id is distinguishable by updatedAt", () => {
  const older = channelFromEvent(event());
  const newer = channelFromEvent(
    event({
      created_at: 1_787_800_001,
      tags: [
        ["d", older.id],
        ["name", "renamed"],
      ],
    }),
  );
  assert.ok(newer.updatedAt > older.updatedAt);
  assert.equal(newer.name, "renamed");
});

test("defaults: not archived, no ttl", () => {
  const channel = channelFromEvent(event());
  assert.equal(channel.archived, false);
  assert.equal(channel.ttlSeconds, null);
});

test("archived tag marks the channel hidden-from-sidebar", () => {
  const channel = channelFromEvent(
    event({ tags: [...event().tags, ["archived", "true"]] }),
  );
  assert.equal(channel.archived, true);
});

test("ttl tag marks an ephemeral (huddle) channel", () => {
  const channel = channelFromEvent(
    event({ tags: [...event().tags, ["ttl", "3600"]] }),
  );
  assert.equal(channel.ttlSeconds, 3600);
  // Non-numeric ttl values parse as absent rather than NaN.
  const junk = channelFromEvent(
    event({ tags: [...event().tags, ["ttl", "soon"]] }),
  );
  assert.equal(junk.ttlSeconds, null);
});

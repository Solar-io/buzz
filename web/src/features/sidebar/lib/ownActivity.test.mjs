import assert from "node:assert/strict";
import { test } from "node:test";
import { noteOwnMessage } from "./ownActivity.ts";
import { rankSection } from "./sectionOrder.ts";

const msg = (channel, at, kind = 9) => ({
  kind,
  created_at: at,
  tags: [["h", channel]],
});

test("keeps the newest own message per conversation; ignores older and non-message kinds", () => {
  let last = new Map();
  last = noteOwnMessage(last, msg("a", 100));
  last = noteOwnMessage(last, msg("a", 50));
  last = noteOwnMessage(last, msg("b", 70));
  const same = noteOwnMessage(last, msg("b", 999, 7));
  assert.equal(same, last, "a reaction is not talking");
  assert.equal(
    noteOwnMessage(last, { kind: 9, created_at: 1, tags: [] }),
    last,
  );
  assert.deepEqual(
    [...last],
    [
      ["a", 100],
      ["b", 70],
    ],
  );
});

test("the conversation you just wrote in tops the four; the oldest of five drops to A-Z (Sam, 2026-10-04)", () => {
  const names = [
    "Systems 1",
    "Sift",
    "Burst",
    "Screen Time",
    "Buzz Audio",
    "Alpha",
  ];
  let last = new Map();
  // Heavy use of Systems 1 days ago, then this morning's work.
  for (let i = 0; i < 30; i += 1)
    last = noteOwnMessage(last, msg("Systems 1", 1000 + i));
  last = noteOwnMessage(last, msg("Sift", 2000));
  last = noteOwnMessage(last, msg("Burst", 3000));
  last = noteOwnMessage(last, msg("Screen Time", 9000));
  last = noteOwnMessage(last, msg("Buzz Audio", 9500));
  const rank = () =>
    rankSection(
      names,
      (name) => name,
      (name) => ({
        unread: false,
        score: last.get(name) ?? 0,
        lastActivity: 0,
        name,
      }),
    );
  assert.deepEqual(rank(), [
    "Buzz Audio",
    "Screen Time",
    "Burst",
    "Sift",
    "Alpha",
    "Systems 1",
  ]);
  last = noteOwnMessage(last, msg("Sift", 9900));
  assert.deepEqual(rank().slice(0, 4), [
    "Sift",
    "Buzz Audio",
    "Screen Time",
    "Burst",
  ]);
});

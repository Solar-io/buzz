import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatLastReplyTime,
  threadParticipants,
  threadSummaryLine,
} from "./threadSummary.ts";

const message = (authorPubkey, createdAt = 0) => ({
  id: `${authorPubkey}-${createdAt}`,
  channelId: "c",
  authorPubkey,
  createdAt,
  content: "",
  kind: 9,
  rootId: null,
  replyToId: null,
  mentionPubkeys: [],
  imetaByUrl: new Map(),
  edited: false,
  deleted: false,
});

test("the root author leads and repliers follow in first-spoken order", () => {
  const root = message("alice", 1);
  const replies = [message("bob", 2), message("carol", 3), message("bob", 4)];
  const participants = threadParticipants(root, replies);
  assert.deepEqual(participants.shown, ["alice", "bob", "carol"]);
  assert.equal(participants.total, 3, "bob is counted once");
  assert.equal(participants.overflow, 0);
});

test("a thread with no replies still has its author", () => {
  const participants = threadParticipants(message("alice", 1), []);
  assert.deepEqual(participants.shown, ["alice"]);
  assert.equal(participants.total, 1);
});

test("participants past the stack limit become an overflow count", () => {
  const root = message("a", 1);
  const replies = ["b", "c", "d", "e", "f"].map((p, i) => message(p, i + 2));
  const participants = threadParticipants(root, replies, 4);
  assert.deepEqual(participants.shown, ["a", "b", "c", "d"]);
  assert.equal(participants.overflow, 2);
  assert.equal(participants.total, 6);
});

test("the relative ladder matches the desktop's thresholds", () => {
  const now = 1_000_000;
  assert.equal(formatLastReplyTime(now - 30, now), "just now");
  assert.equal(formatLastReplyTime(now - 60, now), "1 minute ago");
  assert.equal(formatLastReplyTime(now - 120, now), "2 minutes ago");
  assert.equal(formatLastReplyTime(now - 3600, now), "1 hour ago");
  assert.equal(formatLastReplyTime(now - 7200, now), "2 hours ago");
  assert.equal(formatLastReplyTime(now - 86_400, now), "1 day ago");
  assert.equal(formatLastReplyTime(now - 3 * 86_400, now), "3 days ago");
});

test("beyond a week it becomes an absolute short date", () => {
  // 2026-08-28T00:00:00Z plus enough hours to be past midnight in any
  // negative-offset zone the test host might use.
  const august28 = Date.UTC(2026, 7, 28, 18, 0, 0) / 1000;
  const later = august28 + 30 * 86_400;
  assert.equal(formatLastReplyTime(august28, later), "on Aug 28");
});

test("a future timestamp clamps to 'just now' rather than going negative", () => {
  assert.equal(formatLastReplyTime(2000, 1000), "just now");
});

test("the summary line pluralises and dates the last reply", () => {
  const now = 1_000_000;
  assert.equal(threadSummaryLine(0, null, now), "0 replies");
  assert.equal(
    threadSummaryLine(1, now - 120, now),
    "1 reply · last reply 2 minutes ago",
  );
  assert.equal(
    threadSummaryLine(4, now - 120, now),
    "4 replies · last reply 2 minutes ago",
  );
  assert.equal(
    threadSummaryLine(3, null, now),
    "3 replies",
    "no timestamp means no date clause",
  );
});

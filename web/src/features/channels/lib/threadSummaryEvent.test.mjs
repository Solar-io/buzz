import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeRelayThreadSummary,
  mergeThreadCounts,
  relayThreadSummaryFromEvent,
  THREAD_SUMMARY_KIND,
} from "./threadSummaryEvent.ts";

function summaryEvent(overrides = {}) {
  const content = {
    reply_count: 2,
    descendant_count: 5,
    last_reply_at: 1700,
    participants: ["erin", "dave", "carol"],
    ...(overrides.content ?? {}),
  };
  return {
    id: overrides.id ?? "sum1",
    pubkey: "relay",
    created_at: overrides.at ?? 1000,
    kind: overrides.kind ?? THREAD_SUMMARY_KIND,
    tags: overrides.tags ?? [
      ["e", "root"],
      ["d", "root"],
      ["h", "chan"],
    ],
    content: overrides.rawContent ?? JSON.stringify(content),
    sig: "s",
  };
}

test("the summary kind is 39005", () => {
  assert.equal(THREAD_SUMMARY_KIND, 39005);
});

test("a 39005 parses into counts, participants and the channel", () => {
  const parsed = relayThreadSummaryFromEvent(summaryEvent());
  assert.equal(parsed.rootId, "root");
  assert.equal(parsed.channelId, "chan");
  assert.equal(parsed.replyCount, 2);
  assert.equal(parsed.descendantCount, 5);
  assert.equal(parsed.lastReplyAt, 1700);
  assert.deepEqual(parsed.participants, ["erin", "dave", "carol"]);
});

test("reply_count and descendant_count are read from their own fields", () => {
  // Values chosen so a swap of the two fields fails loudly.
  const parsed = relayThreadSummaryFromEvent(
    summaryEvent({ content: { reply_count: 3, descendant_count: 11 } }),
  );
  assert.equal(parsed.replyCount, 3);
  assert.equal(parsed.descendantCount, 11);
});

test("another kind is not a thread summary", () => {
  assert.equal(relayThreadSummaryFromEvent(summaryEvent({ kind: 9 })), null);
});

test("a summary with no root tag is unusable", () => {
  assert.equal(
    relayThreadSummaryFromEvent(summaryEvent({ tags: [["h", "chan"]] })),
    null,
  );
});

test("malformed content is rejected rather than half-parsed", () => {
  assert.equal(
    relayThreadSummaryFromEvent(summaryEvent({ rawContent: "not json" })),
    null,
  );
});

test("a missing last_reply_at is null, not zero", () => {
  const parsed = relayThreadSummaryFromEvent(
    summaryEvent({ content: { last_reply_at: null } }),
  );
  assert.equal(parsed.lastReplyAt, null);
});

test("newest summary wins per root", () => {
  const first = relayThreadSummaryFromEvent(summaryEvent({ at: 1000 }));
  const second = relayThreadSummaryFromEvent(
    summaryEvent({ at: 2000, content: { descendant_count: 9 } }),
  );
  const once = mergeRelayThreadSummary(new Map(), first);
  const twice = mergeRelayThreadSummary(once, second);
  assert.equal(twice.get("root").descendantCount, 9);
});

test("an older summary does not overwrite a newer one, and changes nothing", () => {
  const newer = relayThreadSummaryFromEvent(
    summaryEvent({ at: 2000, content: { descendant_count: 9 } }),
  );
  const older = relayThreadSummaryFromEvent(
    summaryEvent({ at: 1000, content: { descendant_count: 1 } }),
  );
  const map = mergeRelayThreadSummary(new Map(), newer);
  const after = mergeRelayThreadSummary(map, older);
  assert.equal(after, map, "the same reference — a stale event is a no-op");
  assert.equal(after.get("root").descendantCount, 9);
});

test("with no relay summary the local counts stand", () => {
  const merged = mergeThreadCounts(
    {
      replyCount: 2,
      descendantCount: 4,
      lastReplyAt: 900,
      participants: ["a", "b"],
    },
    null,
  );
  assert.equal(merged.descendantCount, 4);
  assert.equal(merged.lastReplyAt, 900);
  assert.deepEqual(merged.participants, ["a", "b"]);
});

test("the relay's higher counts win when the buffer is missing rows", () => {
  const merged = mergeThreadCounts(
    {
      replyCount: 1,
      descendantCount: 2,
      lastReplyAt: 900,
      participants: ["a"],
    },
    relayThreadSummaryFromEvent(
      summaryEvent({
        content: {
          reply_count: 4,
          descendant_count: 12,
          last_reply_at: 1700,
          participants: ["z"],
        },
      }),
    ),
  );
  assert.equal(merged.replyCount, 4);
  assert.equal(merged.descendantCount, 12);
  assert.equal(merged.lastReplyAt, 1700);
});

test("the local counts win when the relay overlay is stale-low", () => {
  const merged = mergeThreadCounts(
    {
      replyCount: 6,
      descendantCount: 20,
      lastReplyAt: 5000,
      participants: ["a"],
    },
    relayThreadSummaryFromEvent(
      summaryEvent({
        content: {
          reply_count: 1,
          descendant_count: 1,
          last_reply_at: 100,
          participants: [],
        },
      }),
    ),
  );
  assert.equal(merged.replyCount, 6);
  assert.equal(merged.descendantCount, 20);
  assert.equal(merged.lastReplyAt, 5000);
});

test("participants merge as a set, relay order reversed to oldest-first", () => {
  const merged = mergeThreadCounts(
    {
      replyCount: 1,
      descendantCount: 1,
      lastReplyAt: 10,
      participants: ["carol"],
    },
    relayThreadSummaryFromEvent(
      summaryEvent({ content: { participants: ["erin", "dave"] } }),
    ),
    3,
  );
  assert.deepEqual(
    merged.participants,
    ["dave", "erin", "carol"],
    "relay newest-first becomes oldest-first; carol is not duplicated",
  );
});

test("the participant list is capped, keeping the most recent end", () => {
  const merged = mergeThreadCounts(
    {
      replyCount: 1,
      descendantCount: 1,
      lastReplyAt: 10,
      participants: ["p1", "p2", "p3", "p4"],
    },
    null,
    2,
  );
  assert.deepEqual(merged.participants, ["p3", "p4"]);
});

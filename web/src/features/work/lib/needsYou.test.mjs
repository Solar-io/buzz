import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInboxItems } from "@/features/home/lib/inboxItem.ts";
import {
  buildNeeds,
  filterByChip,
  needCounts,
  scopedNeeds,
  scopeNeeds,
  sortNeeds,
} from "./needsYou.ts";

/**
 * Needs you: the merge, the dedupe, the sort and the scope (phase-1 §2.1–2.3).
 * Every expectation is a hardcoded key list, never derived from the module.
 */

const SELF = "aa".repeat(32);
const AGENT = "bb".repeat(32);
const HUMAN = "cc".repeat(32);
const GENERAL = "11111111-1111-4111-8111-111111111111";
const DESIGN = "22222222-2222-4222-8222-222222222222";
const DM = "33333333-3333-4333-8333-333333333333";
const NOW = 100_000;

const channels = [
  { id: GENERAL, name: "general", type: "stream" },
  { id: DESIGN, name: "design", type: "stream" },
  { id: DM, name: "Agent", type: "dm" },
];

function message(overrides) {
  return {
    id: "m0",
    channelId: GENERAL,
    authorPubkey: HUMAN,
    createdAt: 1_000,
    content: "hello",
    kind: 9,
    rootId: null,
    replyToId: null,
    mentionPubkeys: [],
    imetaByUrl: new Map(),
    linkPreviews: [],
    card: null,
    cardAnswer: null,
    edited: false,
    deleted: false,
    ...overrides,
  };
}

const CARD = {
  title: "Beat 03 hold: 1.5s or keep 2s?",
  questions: [{ id: "q1", prompt: "Hold?", options: [] }],
};

function interview(id, channelId, createdAt, author = AGENT) {
  const ask = {
    id,
    channelId,
    channelType: "stream",
    authorPubkey: author,
    createdAt,
    card: CARD,
    rootId: null,
    replyToId: null,
  };
  return {
    id,
    ask,
    round: 1,
    rounds: 1,
    earlier: 0,
    progress: { answered: 0, total: 1 },
  };
}

function approval(ref, createdAt, channelId = GENERAL, expiresAt = null) {
  return {
    ref,
    eventId: `ev-${ref}`,
    workflowId: "wf",
    runId: "run",
    stepId: "step",
    channelId,
    text: `approve ${ref}`,
    createdAt,
    expiresAt,
  };
}

function reminder(id, notBefore, target, status = "pending") {
  return {
    id,
    notBefore,
    content: { status, target, note: undefined },
    createdAt: notBefore - 10,
    eventId: `rev-${id}`,
  };
}

const unreadEverything = () => false;

function items(messages) {
  return buildInboxItems({
    messages,
    channels,
    selfPubkey: SELF,
    isRead: unreadEverything,
  });
}

test("merges asks, mentions, approvals and feedback with chip counts", () => {
  const inputs = {
    interviews: [interview("card-1", GENERAL, 5_000)],
    inboxItems: items([
      message({ id: "mention-1", channelId: DESIGN, mentionPubkeys: [SELF] }),
      // A DM that also mentions me is a DM row — the Inbox keeps it.
      message({ id: "dm-1", channelId: DM, mentionPubkeys: [SELF] }),
    ]),
    approvals: [approval("ref-1", 4_000)],
    reminders: [
      reminder("rem-1", NOW - 60, {
        eventId: "t1",
        channelId: GENERAL,
        preview: "look at this",
        authorPubkey: HUMAN,
      }),
      reminder("rem-done", NOW - 60, undefined, "done"),
    ],
  };
  const rows = buildNeeds(inputs, NOW);
  // Harness guard: every source contributed before anything is counted.
  for (const kind of ["ask", "mention", "approval", "feedback"]) {
    assert.ok(
      rows.some((row) => row.kind === kind),
      `source ${kind} contributed a row`,
    );
  }
  assert.deepEqual(rows.map((row) => row.key).sort(), [
    "approval:ref-1",
    "ask:card-1",
    "feedback:rem-1",
    `mention:mention-1`,
  ]);
  assert.deepEqual(needCounts(rows), {
    all: 4,
    approvals: 1,
    asks: 2,
    feedback: 1,
    overdue: 1,
  });
  assert.deepEqual(
    filterByChip(rows, "asks")
      .map((row) => row.kind)
      .sort(),
    ["ask", "mention"],
    "mentions sit under the Asks chip (D2)",
  );
});

test("a card that p-tags me is one ASK row, never also a MENTION", () => {
  const card = message({
    id: "card-7",
    channelId: GENERAL,
    authorPubkey: AGENT,
    mentionPubkeys: [SELF],
    card: CARD,
  });
  const rows = buildNeeds(
    {
      interviews: [interview("card-7", GENERAL, 1_000)],
      inboxItems: items([card]),
      approvals: [],
      reminders: [],
    },
    NOW,
  );
  assert.equal(items([card]).length, 1, "the card IS an inbox mention item");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["ask:card-7"],
  );
});

test("sort: blocking newest-first, then mentions, then feedback most-overdue-first", () => {
  const rows = buildNeeds(
    {
      interviews: [
        interview("card-old", GENERAL, 2_000),
        interview("card-new", GENERAL, 9_000),
      ],
      inboxItems: items([
        message({
          id: "mention-x",
          createdAt: 50_000,
          mentionPubkeys: [SELF],
        }),
      ]),
      approvals: [approval("ref-mid", 5_000)],
      reminders: [
        reminder("due-soon", NOW + 600),
        reminder("due-later", NOW + 7_200),
        reminder("over-1h", NOW - 3_600),
        reminder("over-1d", NOW - 86_400),
      ],
    },
    NOW,
  );
  assert.deepEqual(
    sortNeeds(rows, NOW).map((row) => row.key),
    [
      "ask:card-new",
      "approval:ref-mid",
      "ask:card-old",
      "mention:mention-x",
      "feedback:over-1d",
      "feedback:over-1h",
      "feedback:due-soon",
      "feedback:due-later",
    ],
  );
});

test("approval expiring within the hour pins above a newer ask", () => {
  const rows = buildNeeds(
    {
      interviews: [interview("card-fresh", GENERAL, NOW - 5)],
      inboxItems: [],
      approvals: [
        approval("ref-far", 1_000, GENERAL, NOW + 7_200),
        approval("ref-soon", 1_000, GENERAL, NOW + 1_800),
        approval("ref-sooner", 1_100, GENERAL, NOW + 600),
      ],
      reminders: [],
    },
    NOW,
  );
  assert.deepEqual(
    sortNeeds(rows, NOW).map((row) => row.key),
    [
      "approval:ref-sooner",
      "approval:ref-soon",
      "ask:card-fresh",
      "approval:ref-far",
    ],
  );
});

test("This channel keeps only the open channel; note-only feedback is Everywhere-only", () => {
  const rows = buildNeeds(
    {
      interviews: [
        interview("card-g", GENERAL, 1_000),
        interview("card-d", DESIGN, 1_000),
      ],
      inboxItems: [],
      approvals: [],
      reminders: [reminder("note-only", NOW - 5, undefined)],
    },
    NOW,
  );
  assert.equal(
    rows.find((row) => row.key === "feedback:note-only").channelId,
    null,
  );
  assert.deepEqual(
    scopeNeeds(rows, "channel", GENERAL).map((row) => row.key),
    ["ask:card-g"],
  );
  assert.deepEqual(
    scopeNeeds(rows, "everywhere", GENERAL)
      .map((row) => row.key)
      .sort(),
    ["ask:card-d", "ask:card-g", "feedback:note-only"],
  );
  // On a view page there is no open channel: This channel behaves as Everywhere.
  assert.equal(scopeNeeds(rows, "channel", null).length, 3);
});

test("header count equals rows under All; overdue counts only due feedback", () => {
  const rows = buildNeeds(
    {
      interviews: [
        interview("card-g", GENERAL, 1_000),
        interview("card-d", DESIGN, 1_000),
      ],
      inboxItems: [],
      approvals: [approval("ref-d", 1_000, DESIGN)],
      reminders: [
        reminder("late", NOW - 100, {
          eventId: "e",
          channelId: GENERAL,
          preview: "p",
          authorPubkey: HUMAN,
        }),
        reminder("upcoming", NOW + 100, {
          eventId: "f",
          channelId: GENERAL,
          preview: "p",
          authorPubkey: HUMAN,
        }),
      ],
    },
    NOW,
  );
  const { needs, counts } = scopedNeeds(rows, "channel", GENERAL, NOW);
  assert.equal(rows.length, 5, "five rows before the scope");
  assert.equal(counts.all, 3, "card-g + late + upcoming");
  assert.equal(counts.all, filterByChip(needs, "all").length);
  assert.equal(counts.overdue, 1, "the upcoming reminder is not overdue");
  assert.equal(counts.approvals, 0, "the approval lives in #design");
  assert.equal(counts.asks, 1, "card-d lives in #design");
});

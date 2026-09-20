import assert from "node:assert/strict";
import { test } from "node:test";
import { sendCardAnswer, sendCardInterviewAnswer } from "./cardAnswer.ts";
import { parseCardTags } from "./decisionCard.ts";
import { parseCardAnswerTags } from "./cardAnswerTag.ts";
import { message } from "@/features/home/lib/inboxFixtures.mjs";

// A plain fake session: sendCardAnswer must hand the signed event to
// publish() and pass the {ok, message} verdict through untouched.
function fakeSession() {
  const calls = [];
  return {
    calls,
    async publish(event) {
      calls.push(event);
      return { ok: true, message: "" };
    },
  };
}

const card = message({
  id: "card-1",
  channelId: "ch-1",
  authorPubkey: "bb".repeat(32),
  kind: 9,
  rootId: null,
  replyToId: null,
  card: { title: "Ship?", options: [{ id: "0", label: "Yes" }] },
});

test("a top-level card's answer e-tags the card as its own root", async () => {
  const session = fakeSession();
  const result = await sendCardAnswer(session, card, "  Yes  ");
  assert.equal(result.ok, true);
  assert.equal(session.calls.length, 1);
  const event = session.calls[0];
  assert.equal(event.kind, 9);
  // One e tag: root === reply target, so the builder collapses to a single
  // reply marker naming the CARD — that marker is what answer detection reads.
  const eTags = event.tags.filter((t) => t[0] === "e");
  assert.deepEqual(eTags, [["e", "card-1", "", "reply"]]);
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "p"),
    [["p", "bb".repeat(32)]],
  );
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "h"),
    [["h", "ch-1"]],
  );
  assert.equal(event.content, "Yes");
});

test("a card that is itself a reply keeps ITS thread root", async () => {
  // The relay rejects a self-rooted reply ("root tag does not match thread
  // ancestry", caught live 9/16) — the root must be the card's root.
  const session = fakeSession();
  const nested = { ...card, rootId: "thread-root-1", replyToId: "parent-1" };
  await sendCardAnswer(session, nested, "No");
  const eTags = session.calls[0].tags.filter((t) => t[0] === "e");
  assert.deepEqual(eTags, [
    ["e", "thread-root-1", "", "root"],
    ["e", "card-1", "", "reply"],
  ]);
});

test("the relay verdict passes through untouched, ok:false included", async () => {
  // publish() RESOLVES {ok:false} on rejection — it does not throw. The
  // helper must not swallow or reshape that verdict.
  const session = {
    async publish() {
      return { ok: false, message: "relay refused" };
    },
  };
  const result = await sendCardAnswer(session, card, "Yes");
  assert.deepEqual(result, { ok: false, message: "relay refused" });
});

// ---- the structured path (decision cards v2) ------------------------------

const INTERVIEW = parseCardTags([
  [
    "card",
    JSON.stringify({
      v: 2,
      title: "Release shape",
      questions: [
        {
          id: "scope",
          question: "Which surfaces?",
          options: [
            { id: "web", label: "Web only" },
            { id: "both", label: "Web + desktop" },
          ],
        },
        {
          id: "when",
          question: "When?",
          options: [
            { id: "now", label: "Now" },
            { id: "later", label: "Later" },
          ],
        },
      ],
    }),
  ],
]);

const interviewCard = { ...card, card: INTERVIEW };

test("a structured answer carries BOTH halves in one event", async () => {
  const session = fakeSession();
  const result = await sendCardInterviewAnswer(session, interviewCard, {
    answers: [
      { questionId: "scope", optionIds: ["web"] },
      { questionId: "when", optionIds: ["later"] },
    ],
    note: "ping me when it lands",
  });
  assert.equal(result.ok, true);
  assert.equal(
    session.calls.length,
    1,
    "ONE event per submission, never one per question",
  );
  const event = session.calls[0];
  assert.equal(event.kind, 9);

  // Half one: the reply marker names the CARD — the same rule the plain
  // path follows, and what answer detection reads.
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "e"),
    [["e", "card-1", "", "reply"]],
  );
  // Half two: the machine payload, appended after the p tag.
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "card-answer"),
    [
      [
        "card-answer",
        '{"v":2,"c":"card-1","a":[{"q":"scope","o":["web"]},{"q":"when","o":["later"]}],' +
          '"n":"ping me when it lands","done":true}',
      ],
    ],
  );
  assert.ok(
    event.tags.findIndex((t) => t[0] === "card-answer") >
      event.tags.findIndex((t) => t[0] === "p"),
    "extraTags append after mentions",
  );

  // Half three (the one an agent actually reads): the content.
  assert.equal(
    event.content,
    [
      "**Which surfaces?** — Web only",
      "**When?** — Later",
      "",
      "_Note: ping me when it lands_",
    ].join("\n"),
  );
  assert.equal(result.answer.done, true);
  // The tag on the wire re-reads as the answer the caller was handed.
  assert.deepEqual(parseCardAnswerTags(event.tags), result.answer);
});

test("a partial structured answer says so in the tag AND the first line", async () => {
  const session = fakeSession();
  const result = await sendCardInterviewAnswer(session, interviewCard, {
    answers: [{ questionId: "scope", optionIds: ["both"] }],
  });
  assert.equal(result.answer.done, false);
  const event = session.calls[0];
  assert.ok(
    event.tags.some(
      (t) => t[0] === "card-answer" && t[1].endsWith('"done":false}'),
    ),
    JSON.stringify(event.tags),
  );
  assert.equal(
    event.content,
    [
      "Answered 1 of 2 — the rest are still open.",
      "",
      "**Which surfaces?** — Web + desktop",
      "**When?** — _(not answered)_",
    ].join("\n"),
  );
});

test("a structured answer to a nested card keeps ITS thread root", async () => {
  // Same relay ancestry rule as the plain path, through a different builder
  // — so it is asserted against the structured path too, not assumed.
  const session = fakeSession();
  await sendCardInterviewAnswer(
    session,
    { ...interviewCard, rootId: "thread-root-1", replyToId: "parent-1" },
    { answers: [{ questionId: "scope", optionIds: ["web"] }] },
  );
  assert.deepEqual(
    session.calls[0].tags.filter((t) => t[0] === "e"),
    [
      ["e", "thread-root-1", "", "root"],
      ["e", "card-1", "", "reply"],
    ],
  );
});

test("a draft the builder refuses never reaches the relay", async () => {
  // The builder throws rather than publishing an ambiguous payload; the
  // discriminating assertion is that publish() was not called at all.
  const session = fakeSession();
  await assert.rejects(
    () =>
      sendCardInterviewAnswer(session, interviewCard, {
        answers: [{ questionId: "scope", optionIds: ["mobile"] }],
      }),
    /has no option "mobile"/,
  );
  assert.equal(session.calls.length, 0);
});

test("the structured path passes an ok:false verdict through untouched", async () => {
  const session = {
    async publish() {
      return { ok: false, message: "relay refused" };
    },
  };
  const result = await sendCardInterviewAnswer(session, interviewCard, {
    answers: [{ questionId: "scope", optionIds: ["web"] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, "relay refused");
});

test("the PLAIN path still sends no card-answer tag — v1 stays bit-identical", async () => {
  // This is why "no tag -> answered" must stay in the badge rule: the AskRow
  // chips and the dismiss-and-type path both still go through here.
  const session = fakeSession();
  await sendCardAnswer(session, interviewCard, "Web only");
  const event = session.calls[0];
  assert.equal(event.content, "Web only");
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "card-answer"),
    [],
  );
  assert.equal(parseCardAnswerTags(event.tags), null);
});

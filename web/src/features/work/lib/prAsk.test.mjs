import assert from "node:assert/strict";
import { test } from "node:test";
import { neventEncode } from "nostr-tools/nip19";

import { buildNeeds, scopedNeeds } from "./needsYou.ts";
import { prReference, prReferenceInText } from "./prAsk.ts";

const PR_ID = "ab".repeat(32);
const OWNER = "cd".repeat(32);
const LINK = `buzz://pr?id=${PR_ID}&owner=${OWNER}&d=buzz`;

function card(fields) {
  return {
    v: 1,
    title: "Ship it?",
    questions: [
      {
        id: "1",
        question: fields.title ?? "Ship it?",
        multiSelect: false,
        options: [
          { id: "a", label: "Approve" },
          { id: "b", label: "Hold" },
        ],
        ...fields.question,
      },
    ],
    ...fields,
  };
}

test("the CLI's buzz://pr link in the card body is a PR reference", () => {
  assert.deepEqual(prReference(card({ body: `Tests green. ${LINK}` })), {
    eventId: PR_ID,
    repo: "buzz",
  });
  // In markdown link form, and in a question body, too.
  assert.equal(
    prReference(
      card({
        question: { body: `Review: [the PR](${LINK}).` },
      }),
    )?.eventId,
    PR_ID,
  );
});

test("a nevent naming kind 1618 is a reference; another kind is not", () => {
  const pr = neventEncode({ id: PR_ID, kind: 1618 });
  const note = neventEncode({ id: PR_ID, kind: 1 });
  assert.deepEqual(prReferenceInText(`merge nostr:${pr} please`), {
    eventId: PR_ID,
    repo: null,
  });
  assert.equal(prReferenceInText(`see nostr:${note}`), null);
});

test("not a reference: no id, a bad id, an issue link, an option label", () => {
  assert.equal(prReferenceInText("buzz://pr?owner=x&d=buzz"), null);
  assert.equal(prReferenceInText("buzz://pr?id=1234&d=buzz"), null);
  assert.equal(
    prReferenceInText(`buzz://issue?id=${PR_ID}&owner=${OWNER}&d=buzz`),
    null,
  );
  assert.equal(
    prReference(
      card({
        question: {
          options: [
            { id: "a", label: `Approve ${LINK}` },
            { id: "b", label: "No" },
          ],
        },
      }),
    ),
    null,
    "an option is the answer, not the subject",
  );
  // A cached card restored without `questions` must not throw.
  assert.equal(prReference({ v: 1, title: "Plain" }), null);
});

function interview(id, cardValue) {
  return {
    id,
    ask: {
      id,
      channelId: "chan-1",
      channelType: "stream",
      authorPubkey: "ee".repeat(32),
      createdAt: 1000,
      card: cardValue,
      rootId: null,
      replyToId: null,
    },
    round: 1,
    rounds: 1,
    earlier: 0,
    progress: { answered: 0, total: 1 },
  };
}

test("a PR-merge ask lists as APPROVAL under the Approvals chip", () => {
  const rows = buildNeeds(
    {
      interviews: [
        interview(
          "merge",
          card({ title: "Merge feat(web): Work v2", body: LINK }),
        ),
        interview("plain", card({ title: "Trim to 1.5s?" })),
      ],
      inboxItems: [],
      approvals: [],
      reminders: [],
    },
    2000,
  );
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey["ask:merge"].kind, "approval");
  assert.equal(byKey["ask:merge"].chip, "approvals");
  assert.equal(byKey["ask:merge"].pr.repo, "buzz");
  // Still the card underneath: its actions are the card's options.
  assert.equal(byKey["ask:merge"].source.kind, "ask");
  assert.equal(byKey["ask:plain"].kind, "ask");
  assert.equal(byKey["ask:plain"].pr, null);
  const { counts } = scopedNeeds(rows, "everywhere", null, 2000);
  assert.deepEqual([counts.all, counts.approvals, counts.asks], [2, 1, 1]);
});

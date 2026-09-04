/**
 * NIP-34 issue reading: which status counts, what it means, and what order
 * issues and their comments come out in.
 *
 * The kind→state mapping is asserted against the Rust `GitStatus` enum
 * (`crates/buzz-sdk/src/builders.rs`) rather than against this module's own
 * constants, so a drift in either direction fails here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowedActorsForRoot,
  availableLifecycleTransitions,
  eventToProjectIssue,
  isLifecycleTransitionValid,
  LIFECYCLE_BY_STATUS_KIND,
  nextProjectIssueCommentCreatedAt,
  PROJECT_ISSUE_STATUS,
  projectIssueEventsToIssues,
  projectTaskCategoryFromLabels,
  projectTaskUserLabels,
  STATUS_KIND_BY_LIFECYCLE,
  statusFromLifecycle,
} from "./projectIssues.ts";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const STRANGER = "c".repeat(64);
const REPO = `30617:${OWNER}:buzz`;

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return idCounter.toString(16).padStart(64, "0");
}

function issueEvent({
  author = AUTHOR,
  content = "Body text",
  createdAt = 1_000,
  id = nextId(),
  labels = [],
  repoAddress = REPO,
  subject = "Something is broken",
} = {}) {
  const tags = [
    ["a", repoAddress],
    ["p", OWNER],
    ["subject", subject],
  ];
  for (const label of labels) tags.push(["t", label]);
  return {
    id,
    pubkey: author,
    kind: 1621,
    created_at: createdAt,
    content,
    tags,
  };
}

function statusEvent({ kind, issueId, signer = OWNER, createdAt = 2_000 }) {
  return {
    id: nextId(),
    pubkey: signer,
    kind,
    created_at: createdAt,
    content: "",
    tags: [
      ["e", issueId, "", "root"],
      ["p", OWNER],
      ["a", REPO],
    ],
  };
}

function commentEvent({
  author = STRANGER,
  content = "a comment",
  createdAt = 1_500,
  issueId,
  rootTagName = "e",
}) {
  return {
    id: nextId(),
    pubkey: author,
    kind: 1,
    created_at: createdAt,
    content,
    tags: [
      [rootTagName, issueId, "", "root"],
      ["a", REPO],
    ],
  };
}

// ── Kind ↔ state, against the Rust enum ────────────────────────────────────

test("status kinds map to the states the Rust GitStatus enum defines", () => {
  // crates/buzz-sdk/src/builders.rs — GitStatus::kind():
  //   Open => 1630, AppliedOrResolved => 1631, Closed => 1632, Draft => 1633.
  assert.deepEqual(LIFECYCLE_BY_STATUS_KIND, {
    1630: "open",
    1631: "resolved",
    1632: "closed",
    1633: "draft",
  });
  assert.deepEqual(STATUS_KIND_BY_LIFECYCLE, {
    open: 1630,
    resolved: 1631,
    closed: 1632,
    draft: 1633,
  });
});

test("an issue with no status event has no lifecycle at all", () => {
  const issue = eventToProjectIssue(issueEvent());
  assert.equal(issue.lifecycle, null);
  assert.equal(issue.statusEventId, null);
  assert.equal(issue.status, PROJECT_ISSUE_STATUS.BACKLOG);
});

for (const [kind, lifecycle, status] of [
  [1630, "open", PROJECT_ISSUE_STATUS.BACKLOG],
  [1631, "resolved", PROJECT_ISSUE_STATUS.DONE],
  [1632, "closed", PROJECT_ISSUE_STATUS.CLOSED],
  [1633, "draft", PROJECT_ISSUE_STATUS.TRIAGE],
]) {
  test(`a kind:${kind} status from the repo owner reads as ${lifecycle}`, () => {
    const root = issueEvent();
    const issue = eventToProjectIssue(root, [
      statusEvent({ kind, issueId: root.id }),
    ]);
    assert.equal(issue.lifecycle, lifecycle);
    assert.equal(issue.status, status);
  });
}

// ── Who may move an issue ──────────────────────────────────────────────────

test("the trusted actors are the issue author and the repo owner", () => {
  const actors = allowedActorsForRoot(issueEvent());
  assert.deepEqual(actors, new Set([AUTHOR, OWNER]));
});

test("a status event from an untrusted signer does not move the issue", () => {
  const root = issueEvent();
  const issue = eventToProjectIssue(root, [
    // Newest event wins on timestamp, so a naive reader would take this one.
    statusEvent({
      kind: 1632,
      issueId: root.id,
      signer: STRANGER,
      createdAt: 9_000,
    }),
    statusEvent({ kind: 1631, issueId: root.id, createdAt: 2_000 }),
  ]);
  // Resolved, not Closed: the values discriminate, so a reader that trusted
  // the newest status would fail here rather than agree by coincidence.
  assert.equal(issue.lifecycle, "resolved");
  assert.equal(issue.status, PROJECT_ISSUE_STATUS.DONE);
});

test("an untrusted signer cannot even give a statusless issue a status", () => {
  const root = issueEvent();
  const issue = eventToProjectIssue(root, [
    statusEvent({ kind: 1632, issueId: root.id, signer: STRANGER }),
  ]);
  assert.equal(issue.lifecycle, null);
});

test("a status event naming a different issue is ignored", () => {
  const root = issueEvent();
  const other = issueEvent();
  const issue = eventToProjectIssue(root, [
    statusEvent({ kind: 1632, issueId: other.id }),
  ]);
  assert.equal(issue.lifecycle, null);
});

test("the newest trusted status wins, and reopening is just a later status", () => {
  const root = issueEvent();
  const issue = eventToProjectIssue(root, [
    statusEvent({ kind: 1632, issueId: root.id, createdAt: 2_000 }),
    statusEvent({
      kind: 1630,
      issueId: root.id,
      signer: AUTHOR,
      createdAt: 3_000,
    }),
  ]);
  assert.equal(issue.lifecycle, "open");
});

// ── Transitions ────────────────────────────────────────────────────────────

test("every state is reachable except the one the issue is already in", () => {
  assert.deepEqual(availableLifecycleTransitions(null), [
    "open",
    "draft",
    "resolved",
    "closed",
  ]);
  assert.deepEqual(availableLifecycleTransitions("closed"), [
    "open",
    "draft",
    "resolved",
  ]);
  assert.equal(isLifecycleTransitionValid("closed", "closed"), false);
  assert.equal(isLifecycleTransitionValid("closed", "open"), true);
  assert.equal(isLifecycleTransitionValid(null, "open"), true);
});

// ── Board labels ───────────────────────────────────────────────────────────

test("board labels fall back to `t` labels only while no status kind applies", () => {
  assert.equal(
    statusFromLifecycle(null, ["in-progress"]),
    PROJECT_ISSUE_STATUS.IN_PROGRESS,
  );
  assert.equal(
    statusFromLifecycle(null, ["review"]),
    PROJECT_ISSUE_STATUS.IN_REVIEW,
  );
  assert.equal(
    statusFromLifecycle(null, ["triage"]),
    PROJECT_ISSUE_STATUS.TRIAGE,
  );
  assert.equal(statusFromLifecycle(null, []), PROJECT_ISSUE_STATUS.BACKLOG);
  // A closed issue stays closed however it is labelled — protocol beats label.
  assert.equal(
    statusFromLifecycle("closed", ["in-progress"]),
    PROJECT_ISSUE_STATUS.CLOSED,
  );
});

test("category comes from labels and is stripped out of the user labels", () => {
  assert.equal(projectTaskCategoryFromLabels(["improvement"]), "improvement");
  assert.equal(projectTaskCategoryFromLabels(["urgent"]), "issue");
  assert.deepEqual(projectTaskUserLabels(["change-request", "urgent", "ui"]), [
    "urgent",
    "ui",
  ]);
});

// ── Comments and ordering ──────────────────────────────────────────────────

test("comments attach by root tag, in either NIP-10 or NIP-22 casing", () => {
  const root = issueEvent();
  const issue = eventToProjectIssue(
    root,
    [],
    [
      commentEvent({ issueId: root.id, content: "lower e", createdAt: 1_100 }),
      commentEvent({
        issueId: root.id,
        content: "upper E",
        createdAt: 1_200,
        rootTagName: "E",
      }),
      commentEvent({ issueId: nextId(), content: "other issue" }),
    ],
  );
  assert.deepEqual(
    issue.comments.map((comment) => comment.content),
    ["lower e", "upper E"],
  );
});

test("a status event is not mistaken for a comment", () => {
  const root = issueEvent();
  const status = statusEvent({ kind: 1632, issueId: root.id });
  const issue = eventToProjectIssue(root, [status], [status]);
  assert.equal(issue.comments.length, 0);
});

test("updatedAt tracks the latest of root, status and comments", () => {
  const root = issueEvent({ createdAt: 1_000 });
  assert.equal(eventToProjectIssue(root).updatedAt, 1_000);
  assert.equal(
    eventToProjectIssue(
      root,
      [],
      [commentEvent({ issueId: root.id, createdAt: 1_500 })],
    ).updatedAt,
    1_500,
  );
  assert.equal(
    eventToProjectIssue(root, [
      statusEvent({ kind: 1632, issueId: root.id, createdAt: 4_000 }),
    ]).updatedAt,
    4_000,
  );
});

test("issues list by most recent activity, not creation", () => {
  const older = issueEvent({ createdAt: 1_000, subject: "Older" });
  const newer = issueEvent({ createdAt: 2_000, subject: "Newer" });
  const list = projectIssueEventsToIssues(
    [older, newer],
    [],
    [commentEvent({ issueId: older.id, createdAt: 5_000 })],
  );
  assert.deepEqual(
    list.map((issue) => issue.title),
    ["Older", "Newer"],
  );
});

test("non-issue events are not folded into the issue list", () => {
  const root = issueEvent();
  const status = statusEvent({ kind: 1632, issueId: root.id });
  assert.equal(projectIssueEventsToIssues([root, status]).length, 1);
});

test("the title falls back to the first body line when there is no subject", () => {
  const issue = eventToProjectIssue({
    id: nextId(),
    pubkey: AUTHOR,
    kind: 1621,
    created_at: 1,
    content: "First line\nsecond line",
    tags: [["a", REPO]],
  });
  assert.equal(issue.title, "First line");
});

test("consecutive comments from one author keep their written order", () => {
  const root = issueEvent();
  const issue = eventToProjectIssue(
    root,
    [],
    [commentEvent({ issueId: root.id, author: AUTHOR, createdAt: 5_000 })],
  );
  // Nostr timestamps are whole seconds; a second reply written inside the same
  // second must still sort after the first.
  assert.equal(nextProjectIssueCommentCreatedAt(issue, 5_000, AUTHOR), 5_001);
  assert.equal(nextProjectIssueCommentCreatedAt(issue, 9_000, AUTHOR), 9_000);
  assert.equal(nextProjectIssueCommentCreatedAt(issue, 5_000, STRANGER), 5_000);
});

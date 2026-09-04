/**
 * Serialisation: the events this client signs must be the events the Rust
 * builders emit.
 *
 * The oracles are `crates/buzz-sdk/src/builders.rs` (`build_git_issue`,
 * `build_git_status`) for the NIP-34 tag layouts, and
 * `docs/nips/NIP-MP.fixtures.json` for the kind:30621 envelope — the same
 * fixture file the relay validator and the Rust builder are tested against.
 * Asserting a hand-written expectation here would only pin this module to
 * itself.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildGitIssueTags,
  buildGitIssueTemplate,
  buildGitStatusTags,
  buildInitialProjectTemplates,
  buildIssueCommentTemplate,
  buildIssueStatusTemplate,
  projectDtagFromName,
} from "./projectEvents.ts";
import {
  eventToProject,
  eventToRepository,
  validateProjectEventEnvelope,
} from "./projectModels.ts";

const envelopeFixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../../docs/nips/NIP-MP.fixtures.json", import.meta.url),
    ),
    "utf8",
  ),
);

const OWNER = envelopeFixtures.owners.a;
const OTHER = envelopeFixtures.owners.b;
const REPO = `30617:${OWNER}:buzz`;
const ISSUE_ID = "d".repeat(64);

test("the envelope oracle exposes the owner keys these cases build on", () => {
  assert.match(OWNER, /^[0-9a-f]{64}$/);
  assert.match(OTHER, /^[0-9a-f]{64}$/);
  assert.notEqual(OWNER, OTHER);
});

// ── kind:1621 issue, against build_git_issue ───────────────────────────────

test("issue tags follow build_git_issue exactly", () => {
  // crates/buzz-sdk/src/builders.rs — build_git_issue pushes, in order:
  //   ["a", <repo coord>], ["p", <repo owner>], ["p", …recipients],
  //   ["subject", <subject>], then one ["t", …] per label.
  assert.deepEqual(
    buildGitIssueTags({
      repoAddress: REPO,
      repoOwner: OWNER,
      title: "  Crash on launch  ",
      recipients: [OTHER],
      labels: ["issue", " ", "ui"],
    }),
    [
      ["a", REPO],
      ["p", OWNER],
      ["p", OTHER],
      ["subject", "Crash on launch"],
      ["t", "issue"],
      ["t", "ui"],
    ],
  );
});

test("an issue template carries the trimmed markdown body as content", () => {
  const template = buildGitIssueTemplate({
    body: "  ## Steps\n\n1. open it  ",
    repoAddress: REPO,
    repoOwner: OWNER,
    title: "Crash",
  });
  assert.equal(template.kind, 1621);
  assert.equal(template.content, "## Steps\n\n1. open it");
});

test("an issue must name a kind:30617 repository", () => {
  assert.throws(
    () =>
      buildGitIssueTags({
        repoAddress: `30621:${OWNER}:platform`,
        repoOwner: OWNER,
        title: "Crash",
      }),
    /kind:30617/,
  );
});

test("issue subject bounds match the Rust builder's", () => {
  // build_git_issue: empty subject and >256 characters are both InvalidInput.
  assert.throws(
    () =>
      buildGitIssueTags({ repoAddress: REPO, repoOwner: OWNER, title: "  " }),
    /title is required/,
  );
  assert.doesNotThrow(() =>
    buildGitIssueTags({
      repoAddress: REPO,
      repoOwner: OWNER,
      title: "x".repeat(256),
    }),
  );
  assert.throws(
    () =>
      buildGitIssueTags({
        repoAddress: REPO,
        repoOwner: OWNER,
        title: "x".repeat(257),
      }),
    /256 characters or fewer/,
  );
});

test("a malformed owner or recipient is refused, not lowercased into shape", () => {
  assert.throws(
    () =>
      buildGitIssueTags({ repoAddress: REPO, repoOwner: "abc", title: "x" }),
    /64 hex/,
  );
  assert.throws(
    () =>
      buildGitIssueTags({
        repoAddress: REPO,
        repoOwner: OWNER,
        title: "x",
        recipients: ["nope"],
      }),
    /64 hex/,
  );
});

// ── kind:1630-1633 status, against build_git_status ────────────────────────

test("status tags follow build_git_status exactly", () => {
  // build_git_status pushes ["e", root, "", "root"], then ["p", …recipients],
  // then ["a", <repo coord>].
  assert.deepEqual(
    buildGitStatusTags({
      rootEventId: ISSUE_ID,
      recipients: [OWNER.toUpperCase(), OTHER, OWNER],
      repoAddress: REPO,
    }),
    [
      ["e", ISSUE_ID, "", "root"],
      ["p", OWNER],
      ["p", OTHER],
      ["a", REPO],
    ],
  );
});

test("a status needs a 64-hex root event id", () => {
  assert.throws(() => buildGitStatusTags({ rootEventId: "not-hex" }), /64 hex/);
});

test("a lifecycle transition publishes the kind that asserts the new state", () => {
  const template = buildIssueStatusTemplate({
    currentLifecycle: "open",
    nextLifecycle: "closed",
    repoAddress: REPO,
    recipients: [OWNER],
    rootEventId: ISSUE_ID,
  });
  assert.equal(template.kind, 1632);
  assert.deepEqual(template.tags[0], ["e", ISSUE_ID, "", "root"]);
});

test("a no-op transition is refused rather than published", () => {
  assert.throws(
    () =>
      buildIssueStatusTemplate({
        currentLifecycle: "closed",
        nextLifecycle: "closed",
        rootEventId: ISSUE_ID,
      }),
    /already closed/,
  );
});

test("an issue comment is a kind:1 note carrying the root and repo tags", () => {
  const template = buildIssueCommentTemplate({
    body: "  looking at it  ",
    repoAddress: REPO,
    rootEventId: ISSUE_ID,
  });
  assert.equal(template.kind, 1);
  assert.equal(template.content, "looking at it");
  assert.deepEqual(template.tags, [
    ["e", ISSUE_ID, "", "root"],
    ["a", REPO],
  ]);
  assert.throws(
    () => buildIssueCommentTemplate({ body: "   ", rootEventId: ISSUE_ID }),
    /cannot be empty/,
  );
});

// ── kind:30621 project, against the ingest fixtures ────────────────────────

test("a created project's envelope is one the relay accepts", () => {
  const { project, repository, repositoryAddress, dtag } =
    buildInitialProjectTemplates({
      name: "Platform Tools",
      description: "Relay, desktop and mobile.",
      ownerPubkey: OWNER,
      channelId: "3580ca9b-47b4-4af9-b22a-1068778f26c6",
      cloneUrl: "https://relay.example/git/x/y",
    });

  assert.equal(dtag, "platform-tools");
  assert.equal(project.kind, 30621);
  assert.equal(repository.kind, 30617);
  assert.equal(repositoryAddress, `30617:${OWNER}:platform-tools`);
  // The same validator the relay runs, on the event we are about to sign.
  validateProjectEventEnvelope(project.tags, project.content);
});

test("a created project and its repository round-trip through the read path", () => {
  const { project, repository } = buildInitialProjectTemplates({
    name: "Platform",
    description: "Grouping.",
    ownerPubkey: OWNER,
  });
  const repositoryModel = eventToRepository({
    id: "1".repeat(64),
    pubkey: OWNER,
    created_at: 10,
    ...repository,
  });
  const projectModel = eventToProject(
    { id: "2".repeat(64), pubkey: OWNER, created_at: 11, ...project },
    new Map([[repositoryModel.repoAddress, repositoryModel]]),
    new Map([[repositoryModel.repoAddress, repositoryModel]]),
  );
  assert.equal(projectModel.name, "Platform");
  assert.equal(projectModel.description, "Grouping.");
  assert.equal(projectModel.visibility, "listed");
  assert.deepEqual(
    projectModel.repositories.map((repo) => repo.repoAddress),
    [`30617:${OWNER}:platform`],
  );
  assert.deepEqual(projectModel.unavailableRepositoryAddresses, []);
});

test("the project slug is derived from the name, and must survive it", () => {
  assert.equal(projectDtagFromName("Buzz — Relay!"), "buzz-relay");
  assert.equal(projectDtagFromName("  Web  UI  "), "web-ui");
  assert.throws(
    () => buildInitialProjectTemplates({ name: "!!!", ownerPubkey: OWNER }),
    /letters or numbers/,
  );
  assert.throws(
    () => buildInitialProjectTemplates({ name: "  ", ownerPubkey: OWNER }),
    /name is required/,
  );
});

test("project metadata bounds match the relay's metadata-length rule", () => {
  // validate_project_envelope: name 256 bytes, description 2048 bytes.
  assert.doesNotThrow(() =>
    buildInitialProjectTemplates({
      name: "a".repeat(256),
      ownerPubkey: OWNER,
    }),
  );
  assert.throws(
    () =>
      buildInitialProjectTemplates({
        name: "a".repeat(257),
        ownerPubkey: OWNER,
      }),
    /256 bytes/,
  );
  assert.throws(
    () =>
      buildInitialProjectTemplates({
        name: "Platform",
        description: "d".repeat(2_049),
        ownerPubkey: OWNER,
      }),
    /2048 bytes/,
  );
});

test("an owner key that is not lowercase 64-hex is refused", () => {
  assert.throws(
    () =>
      buildInitialProjectTemplates({ name: "Platform", ownerPubkey: "nope" }),
    /public key is invalid/,
  );
});

test("a channel id that is not a UUID is refused before signing", () => {
  assert.throws(
    () =>
      buildInitialProjectTemplates({
        name: "Platform",
        ownerPubkey: OWNER,
        channelId: "not-a-uuid",
      }),
    /valid UUID/,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildArchiveRequest,
  buildUnarchiveRequest,
  canArchive,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_ARCHIVED_LIST,
  KIND_IA_UNARCHIVE_REQUEST,
  makeArchivedPredicate,
  pubkeyIssue,
  reasonIssue,
  snapshotArchivedPubkeys,
} from "./identityArchiveEvents.ts";

const TARGET = "a".repeat(64);
const OTHER = "b".repeat(64);
const RELAY = "c".repeat(64);
const SIG = "d".repeat(128);

const alwaysValid = () => true;
const neverValid = () => false;

// ── kind numbers ────────────────────────────────────────────────────────────

test("the three NIP-IA kinds match buzz-core/src/kind.rs", () => {
  assert.equal(KIND_IA_ARCHIVE_REQUEST, 9035);
  assert.equal(KIND_IA_UNARCHIVE_REQUEST, 9036);
  assert.equal(KIND_IA_ARCHIVED_LIST, 13535);
});

// ── tag layout ──────────────────────────────────────────────────────────────

test("an archive request leads with the NIP-70 protected marker", () => {
  const result = buildArchiveRequest({ targetPubkey: TARGET });
  assert.ok("event" in result);
  assert.deepEqual(result.event.tags[0], ["-"]);
});

test("an archive request p-tags the target, lowercased", () => {
  const result = buildArchiveRequest({ targetPubkey: TARGET.toUpperCase() });
  assert.ok("event" in result);
  assert.deepEqual(result.event.tags[1], ["p", TARGET]);
});

test("the minimal archive request is exactly the marker plus the p tag", () => {
  const result = buildArchiveRequest({ targetPubkey: TARGET });
  assert.ok("event" in result);
  assert.deepEqual(result.event.tags, [["-"], ["p", TARGET]]);
  assert.equal(result.event.content, "");
});

test("a reason rides as its own tag", () => {
  const result = buildArchiveRequest({
    targetPubkey: TARGET,
    reason: "rotated",
  });
  assert.ok("event" in result);
  assert.deepEqual(result.event.tags[2], ["reason", "rotated"]);
});

test("replaced-by rides on archive, lowercased", () => {
  const result = buildArchiveRequest({
    targetPubkey: TARGET,
    replacedBy: OTHER.toUpperCase(),
  });
  assert.ok("event" in result);
  assert.ok(
    result.event.tags.some(
      (tag) => tag[0] === "replaced-by" && tag[1] === OTHER,
    ),
  );
});

/**
 * The spec gives `replaced-by` no meaning on unarchive, and the desktop's
 * `build_unarchive_identity_request` passes None. The discriminating check is
 * that the SAME input which produces the tag on 9035 does not produce it here.
 */
test("replaced-by is dropped on unarchive even when supplied", () => {
  const input = { targetPubkey: TARGET, replacedBy: OTHER };
  const archive = buildArchiveRequest(input);
  const unarchive = buildUnarchiveRequest(input);
  assert.ok("event" in archive);
  assert.ok("event" in unarchive);
  assert.ok(archive.event.tags.some((tag) => tag[0] === "replaced-by"));
  assert.equal(
    unarchive.event.tags.some((tag) => tag[0] === "replaced-by"),
    false,
  );
});

test("unarchive is kind 9036 and keeps the marker and p tag", () => {
  const result = buildUnarchiveRequest({
    targetPubkey: TARGET,
    reason: "spam",
  });
  assert.ok("event" in result);
  assert.equal(result.event.kind, 9036);
  assert.deepEqual(result.event.tags[0], ["-"]);
  assert.deepEqual(result.event.tags[1], ["p", TARGET]);
});

test("an auth tag rides with all three of its values", () => {
  const result = buildArchiveRequest({
    targetPubkey: TARGET,
    auth: ["auth", OTHER, "kind=1", SIG],
  });
  assert.ok("event" in result);
  assert.deepEqual(result.event.tags.at(-1), ["auth", OTHER, "kind=1", SIG]);
});

// ── validation ──────────────────────────────────────────────────────────────

test("a short pubkey is refused", () => {
  assert.equal(
    pubkeyIssue("abc", "target_pubkey"),
    "target_pubkey must be 64 hex characters",
  );
  assert.equal(pubkeyIssue(TARGET), null);
});

test("a bad target produces an error rather than an event", () => {
  assert.deepEqual(buildArchiveRequest({ targetPubkey: "nope" }), {
    error: "target_pubkey must be 64 hex characters",
  });
});

test("replaced-by equal to the target is refused", () => {
  assert.deepEqual(
    buildArchiveRequest({ targetPubkey: TARGET, replacedBy: TARGET }),
    { error: "replaced-by must differ from the target" },
  );
});

test("a reason over 64 characters is refused with its length", () => {
  const issue = reasonIssue("x".repeat(65));
  assert.equal(
    issue,
    "reason code exceeds maximum length of 64 chars (got 65)",
  );
});

test("a reason of exactly 64 characters is accepted", () => {
  assert.equal(reasonIssue("x".repeat(64)), null);
});

test("a reason containing a control character is refused", () => {
  assert.equal(
    reasonIssue("bad\u0007reason"),
    "reason code must not contain control characters",
  );
  assert.equal(reasonIssue("left-organization"), null);
});

test("a malformed auth signature is refused", () => {
  const result = buildArchiveRequest({
    targetPubkey: TARGET,
    auth: ["auth", OTHER, "", "short"],
  });
  assert.deepEqual(result, {
    error: "auth tag signature must be 128-character hex",
  });
});

test("an auth tag with the wrong label is refused", () => {
  const result = buildArchiveRequest({
    targetPubkey: TARGET,
    auth: ["oauth", OTHER, "", SIG],
  });
  assert.match(result.error ?? "", /auth tag label must be "auth"/);
});

// ── snapshot reading ────────────────────────────────────────────────────────

function snapshot(overrides = {}) {
  return {
    kind: KIND_IA_ARCHIVED_LIST,
    pubkey: RELAY,
    tags: [
      ["p", TARGET],
      ["p", OTHER],
    ],
    ...overrides,
  };
}

test("a relay-signed snapshot yields its p tags, lowercased", () => {
  const archived = snapshotArchivedPubkeys(
    snapshot({ tags: [["p", TARGET.toUpperCase()]] }),
    RELAY,
    alwaysValid,
  );
  assert.deepEqual(archived, [TARGET]);
});

test("a snapshot from an author other than the relay self is ignored", () => {
  assert.deepEqual(
    snapshotArchivedPubkeys(snapshot({ pubkey: OTHER }), RELAY, alwaysValid),
    [],
  );
});

/**
 * The verifier result must actually gate the outcome. Same snapshot, same
 * relay-self — only `verify` differs, so an implementation that never called
 * it would return the two pubkeys in both cases and fail here.
 */
test("a snapshot that fails signature verification yields nobody", () => {
  assert.equal(
    snapshotArchivedPubkeys(snapshot(), RELAY, alwaysValid).length,
    2,
  );
  assert.deepEqual(snapshotArchivedPubkeys(snapshot(), RELAY, neverValid), []);
});

test("no advertised relay self means nobody is archived", () => {
  assert.deepEqual(snapshotArchivedPubkeys(snapshot(), null, alwaysValid), []);
});

test("a snapshot of the wrong kind is ignored", () => {
  assert.deepEqual(
    snapshotArchivedPubkeys(snapshot({ kind: 13534 }), RELAY, alwaysValid),
    [],
  );
});

test("a missing snapshot yields nobody rather than throwing", () => {
  assert.deepEqual(snapshotArchivedPubkeys(null, RELAY, alwaysValid), []);
});

test("malformed p tags and duplicates are dropped", () => {
  const archived = snapshotArchivedPubkeys(
    snapshot({
      tags: [["p", TARGET], ["p", TARGET], ["p", "short"], ["e", OTHER], ["p"]],
    }),
    RELAY,
    alwaysValid,
  );
  assert.deepEqual(archived, [TARGET]);
});

// ── the self-exemption ──────────────────────────────────────────────────────

/**
 * The anti-shadowban property. `self` is IN the archived list here, so a
 * predicate that merely tested set membership would return true and hide the
 * user from their own client.
 */
test("an archived viewer is never folded from their own client", () => {
  const isArchived = makeArchivedPredicate([TARGET, OTHER], TARGET);
  assert.equal(isArchived(TARGET), false);
  assert.equal(isArchived(OTHER), true);
});

test("the exemption is case-insensitive on both sides", () => {
  const isArchived = makeArchivedPredicate(
    [TARGET.toUpperCase()],
    TARGET.toUpperCase(),
  );
  assert.equal(isArchived(TARGET), false);
});

test("with no viewer key, everyone archived is folded", () => {
  const isArchived = makeArchivedPredicate([TARGET], null);
  assert.equal(isArchived(TARGET), true);
});

test("an unarchived pubkey is never folded", () => {
  assert.equal(makeArchivedPredicate([TARGET], null)(OTHER), false);
});

// ── the render gate ─────────────────────────────────────────────────────────

test("you may always archive yourself", () => {
  assert.equal(
    canArchive({
      targetPubkey: TARGET,
      selfPubkey: TARGET,
      communityRole: "member",
      isOaOwnerOfTarget: false,
    }),
    true,
  );
});

test("a plain member may not archive someone else", () => {
  assert.equal(
    canArchive({
      targetPubkey: OTHER,
      selfPubkey: TARGET,
      communityRole: "member",
      isOaOwnerOfTarget: false,
    }),
    false,
  );
});

test("a relay owner or admin may archive someone else", () => {
  for (const role of ["owner", "admin"]) {
    assert.equal(
      canArchive({
        targetPubkey: OTHER,
        selfPubkey: TARGET,
        communityRole: role,
        isOaOwnerOfTarget: false,
      }),
      true,
      role,
    );
  }
});

test("the verified NIP-OA owner may archive their agent", () => {
  assert.equal(
    canArchive({
      targetPubkey: OTHER,
      selfPubkey: TARGET,
      communityRole: "member",
      isOaOwnerOfTarget: true,
    }),
    true,
  );
});

test("an empty target is never archivable", () => {
  assert.equal(
    canArchive({
      targetPubkey: "  ",
      selfPubkey: TARGET,
      communityRole: "owner",
      isOaOwnerOfTarget: true,
    }),
    false,
  );
});

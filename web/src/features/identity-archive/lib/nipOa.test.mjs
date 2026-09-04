import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authTagShapeIssue,
  conditionsIssue,
  ownerAuthPreimage,
  resolveOaOwner,
} from "./nipOa.ts";

const AGENT = "a".repeat(64);
const OWNER = "b".repeat(64);
const VIEWER = "c".repeat(64);
const SIG = "d".repeat(128);

function kind0(tags) {
  return { pubkey: AGENT, tags };
}

// ── the signing preimage ────────────────────────────────────────────────────

/**
 * Hardcoded, not derived from the function under test. The spec's gotcha #3 is
 * that the subject is the TARGET pubkey; expressing the expectation in terms
 * of `ownerAuthPreimage`'s own inputs would pass no matter which key it used.
 */
test("the preimage is the spec string over the agent pubkey", () => {
  assert.equal(
    ownerAuthPreimage(AGENT, "kind=1"),
    `nostr:agent-auth:${"a".repeat(64)}:kind=1`,
  );
});

test("empty conditions still leave the trailing colon", () => {
  assert.equal(
    ownerAuthPreimage(AGENT, ""),
    `nostr:agent-auth:${"a".repeat(64)}:`,
  );
});

test("the preimage subject is lowercased", () => {
  assert.equal(
    ownerAuthPreimage(AGENT.toUpperCase(), ""),
    ownerAuthPreimage(AGENT, ""),
  );
});

// ── conditions grammar ──────────────────────────────────────────────────────

test("empty conditions are valid", () => {
  assert.equal(conditionsIssue(""), null);
});

test("a single kind clause is valid", () => {
  assert.equal(conditionsIssue("kind=1"), null);
});

test("multiple clauses joined by & are valid", () => {
  assert.equal(
    conditionsIssue("kind=1&created_at>1700000000&created_at<1800000000"),
    null,
  );
});

test("whitespace anywhere is refused", () => {
  assert.equal(
    conditionsIssue("kind=1 &kind=2"),
    "conditions must not contain whitespace",
  );
});

test("a leading, trailing or doubled & is refused", () => {
  for (const value of ["&kind=1", "kind=1&", "kind=1&&kind=2"]) {
    assert.equal(
      conditionsIssue(value),
      "empty clause in conditions (leading/trailing/double '&')",
      value,
    );
  }
});

test("a leading zero is not canonical decimal", () => {
  assert.equal(
    conditionsIssue("kind=01"),
    "kind value must not have leading zeros",
  );
});

test("kind 0 is valid but kind 65536 is out of range", () => {
  assert.equal(conditionsIssue("kind=0"), null);
  assert.equal(conditionsIssue("kind=65535"), null);
  assert.equal(conditionsIssue("kind=65536"), "kind value out of range");
});

test("an unknown clause is named in the error", () => {
  assert.equal(conditionsIssue("author=x"), 'unsupported clause: "author=x"');
});

// ── tag shape ───────────────────────────────────────────────────────────────

test("a well-formed auth tag has no shape issue", () => {
  assert.equal(authTagShapeIssue(["auth", OWNER, "kind=1", SIG]), null);
});

test("a tag of the wrong arity is refused", () => {
  assert.equal(
    authTagShapeIssue(["auth", OWNER, SIG]),
    "auth tag must have exactly 4 elements",
  );
});

test("a bad owner pubkey or signature length is refused", () => {
  assert.match(
    authTagShapeIssue(["auth", "short", "", SIG]) ?? "",
    /owner pubkey must be 64 hex/,
  );
  assert.match(
    authTagShapeIssue(["auth", OWNER, "", "short"]) ?? "",
    /signature must be 128-character hex/,
  );
});

test("bad conditions make the whole tag invalid", () => {
  assert.match(
    authTagShapeIssue(["auth", OWNER, "kind=01", SIG]) ?? "",
    /leading zeros/,
  );
});

// ── owner resolution ────────────────────────────────────────────────────────

test("a verifying auth tag resolves its owner", () => {
  const result = resolveOaOwner(
    kind0([["auth", OWNER, "", SIG]]),
    VIEWER,
    () => true,
  );
  assert.ok(result);
  assert.equal(result.owner, OWNER);
  assert.equal(result.isMe, false);
});

test("isMe is true when the viewer is the owner", () => {
  const result = resolveOaOwner(
    kind0([["auth", OWNER, "", SIG]]),
    OWNER,
    () => true,
  );
  assert.equal(result.isMe, true);
});

/**
 * Same tag, same profile — only the verifier's answer differs. An
 * implementation that trusted the tag without calling it would resolve an
 * owner in both cases, which is exactly the forgery this guards.
 */
test("a tag whose signature does not verify resolves nobody", () => {
  const profile = kind0([["auth", OWNER, "", SIG]]);
  assert.ok(resolveOaOwner(profile, VIEWER, () => true));
  assert.equal(
    resolveOaOwner(profile, VIEWER, () => false),
    null,
  );
});

test("the verifier is handed the target's preimage, not the viewer's", () => {
  const seen = [];
  resolveOaOwner(kind0([["auth", OWNER, "kind=1", SIG]]), VIEWER, (input) => {
    seen.push(input);
    return true;
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].preimage, `nostr:agent-auth:${"a".repeat(64)}:kind=1`);
  assert.equal(seen[0].ownerPubkeyHex, OWNER);
  assert.equal(seen[0].signatureHex, SIG);
});

test("a profile with no auth tag resolves nobody", () => {
  assert.equal(
    resolveOaOwner(kind0([["p", OWNER]]), VIEWER, () => true),
    null,
  );
});

test("a malformed auth tag is skipped and a later valid one still resolves", () => {
  const result = resolveOaOwner(
    kind0([
      ["auth", "short", "", SIG],
      ["auth", OWNER, "", SIG],
    ]),
    VIEWER,
    () => true,
  );
  assert.ok(result);
  assert.equal(result.owner, OWNER);
});

test("a missing profile resolves nobody rather than throwing", () => {
  assert.equal(
    resolveOaOwner(null, VIEWER, () => true),
    null,
  );
});

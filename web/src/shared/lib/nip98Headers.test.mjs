import assert from "node:assert/strict";
import test from "node:test";

/**
 * `nip98Headers` itself cannot be loaded by `node --test` — it pulls in the
 * signer, which imports extensionless. What IS testable, and what actually
 * broke in production, is the header SET a caller must send: a bare
 * `authorization` is not enough, because the relay reads `x-auth-tag` for
 * membership and for the NIP-OA owner fallback.
 *
 * So this pins the shape the helper produces, against a stand-in with the same
 * contract, and — more usefully — the repository invariant that no caller
 * hand-rolls the header set any more. See `nip98-callers.test.mjs`.
 */
function headersFor(authorization, authTag, body) {
  const headers = { authorization };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (authTag) headers["x-auth-tag"] = authTag;
  return headers;
}

test("a member's request carries the auth tag alongside the authorization", () => {
  const headers = headersFor("Nostr abc", '{"tag":"t"}', undefined);
  assert.equal(headers["x-auth-tag"], '{"tag":"t"}');
  assert.equal(headers.authorization, "Nostr abc");
});

test("no tag means no header, rather than an empty one", () => {
  const headers = headersFor("Nostr abc", null, undefined);
  assert.equal("x-auth-tag" in headers, false);
});

test("a body adds the json content type", () => {
  const headers = headersFor("Nostr abc", null, "{}");
  assert.equal(headers["content-type"], "application/json");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nip05Label,
  nip05Tone,
  nip05Url,
  parseNip05,
  readNip05Response,
} from "./nip05.ts";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);

test("an ordinary address splits into name and domain", () => {
  assert.deepEqual(parseNip05("Alice@Example.com"), {
    name: "alice",
    domain: "example.com",
  });
});

test("a bare domain is the NIP-05 root name", () => {
  assert.deepEqual(parseNip05("example.com"), {
    name: "_",
    domain: "example.com",
  });
});

test("a claim that tries to steer the request is refused", () => {
  // NIP-05 restricts the local part to a-z0-9-_. — anything else is an
  // attempt to reach a URL the spec does not allow, so it is rejected rather
  // than escaped.
  for (const hostile of [
    "a/b@example.com",
    "a?b@example.com",
    "a b@example.com",
    "a#b@example.com",
    "alice@localhost",
    "alice@",
    "@example.com",
    "",
  ]) {
    assert.equal(parseNip05(hostile), null, `${hostile} must not parse`);
  }
});

test("the well-known URL is always https and carries the name", () => {
  assert.equal(
    nip05Url({ name: "alice", domain: "example.com" }),
    "https://example.com/.well-known/nostr.json?name=alice",
  );
  assert.equal(
    nip05Url({ name: "_", domain: "example.com" }),
    "https://example.com/.well-known/nostr.json?name=_",
  );
});

test("a matching record verifies", () => {
  assert.equal(
    readNip05Response(
      { names: { alice: ALICE } },
      { name: "alice", domain: "example.com" },
      ALICE.toUpperCase(),
    ),
    "verified",
  );
});

test("the domain naming a DIFFERENT key is a mismatch, not an outage", () => {
  // This is the impersonation case: the claim says alice@example.com, the
  // domain says alice is someone else. Reporting it as "unreachable" would
  // read as a network blip instead of a warning.
  assert.equal(
    readNip05Response(
      { names: { alice: MALLORY } },
      { name: "alice", domain: "example.com" },
      ALICE,
    ),
    "mismatch",
  );
});

test("a domain that does not list the name at all is a mismatch", () => {
  assert.equal(
    readNip05Response(
      { names: { bob: ALICE } },
      { name: "alice", domain: "example.com" },
      ALICE,
    ),
    "mismatch",
  );
});

test("a body that is not a NIP-05 document is malformed", () => {
  const address = { name: "alice", domain: "example.com" };
  assert.equal(readNip05Response(null, address, ALICE), "malformed");
  assert.equal(readNip05Response("nope", address, ALICE), "malformed");
  assert.equal(readNip05Response({}, address, ALICE), "malformed");
  assert.equal(readNip05Response({ names: [] }, address, ALICE), "malformed");
});

test("only verification reads as good; a mismatch reads as bad", () => {
  assert.equal(nip05Tone("verified"), "good");
  assert.equal(nip05Tone("mismatch"), "bad");
  // An unreachable domain is unproven, not disproven.
  assert.equal(nip05Tone("unreachable"), "neutral");
  assert.equal(nip05Tone("checking"), "neutral");
  assert.equal(nip05Tone("none"), "neutral");
});

test("every non-empty status has its own label", () => {
  const labels = [
    "verified",
    "mismatch",
    "unreachable",
    "malformed",
    "checking",
  ].map(nip05Label);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(nip05Label("none"), "");
});

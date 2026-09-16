import assert from "node:assert/strict";
import { test } from "node:test";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { agentNameFromPubkey, rawHuddleAgentEntry } from "./huddleRawEntry.ts";

// A real 32-byte hex key, so the bech32 round-trip is exercised rather than
// mocked. Fixed rather than random: the expected display name below is
// hardcoded, and an expectation derived from the code it pins proves nothing.
const PUBKEY =
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const OTHER = "a".repeat(64);

test("a raw hex key parses to a lowercase pubkey and a truncated display name", () => {
  const result = rawHuddleAgentEntry(PUBKEY, []);
  assert.deepEqual(result, {
    ok: true,
    pubkey: PUBKEY,
    // Hardcoded: the name is `agent ` + first8…last4, so a change to either
    // the prefix or the truncation shape fails this test by name.
    name: "agent 3bf0c63f…459d",
  });
});

test("an uppercase hex key is normalised to lowercase", () => {
  const result = rawHuddleAgentEntry(PUBKEY.toUpperCase(), []);
  assert.equal(result.ok, true);
  assert.equal(result.pubkey, PUBKEY);
});

test("an npub round-trips through the parser to the same key and name", () => {
  const npub = npubEncode(PUBKEY);
  assert.ok(npub.startsWith("npub1"));
  const result = rawHuddleAgentEntry(npub, []);
  assert.deepEqual(result, {
    ok: true,
    pubkey: PUBKEY,
    name: "agent 3bf0c63f…459d",
  });
});

test("an agent already in the huddle is refused before anything is published", () => {
  const result = rawHuddleAgentEntry(PUBKEY, [OTHER, PUBKEY]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "That agent is already in this huddle.");
});

test("the duplicate check is case-insensitive", () => {
  const result = rawHuddleAgentEntry(PUBKEY, [PUBKEY.toUpperCase()]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "That agent is already in this huddle.");
});

test("text that is not a key surfaces the parser's error verbatim", () => {
  const result = rawHuddleAgentEntry("gilfoyle", []);
  assert.equal(result.ok, false);
  assert.equal(
    result.error,
    "Enter a public key: 64 hex characters or an npub… address.",
  );
});

test("a pasted SECRET key surfaces the specific warning, not the generic one", () => {
  // People paste nsecs by mistake; the parser's specific error is the only
  // thing that stops them before a relay round-trip.
  const result = rawHuddleAgentEntry(
    nsecEncode(new Uint8Array(32).fill(7)),
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "That is a SECRET key (nsec), not a public key.");
});

test("a short key is refused, not accepted as a prefix", () => {
  const result = rawHuddleAgentEntry(PUBKEY.slice(0, 63), []);
  assert.equal(result.ok, false);
});

test("agentNameFromPubkey keeps the canonical truncated form on its own", () => {
  assert.equal(agentNameFromPubkey(PUBKEY), "agent 3bf0c63f…459d");
});

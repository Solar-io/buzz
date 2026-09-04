import assert from "node:assert/strict";
import { test } from "node:test";

import { npubEncode, nprofileEncode } from "nostr-tools/nip19";

import { parsePubkeyInput } from "./pubkeyInput.ts";

const HEX = `${"3".repeat(63)}a`;

test("a bare hex key is accepted and lowercased", () => {
  assert.equal(parsePubkeyInput(HEX), HEX);
  assert.equal(parsePubkeyInput(`  ${HEX.toUpperCase()}  `), HEX);
});

test("an npub is decoded to its hex key", () => {
  assert.equal(parsePubkeyInput(npubEncode(HEX)), HEX);
});

test("an nprofile is decoded to its hex key", () => {
  assert.equal(
    parsePubkeyInput(nprofileEncode({ pubkey: HEX, relays: [] })),
    HEX,
  );
});

test("a nostr: URI wrapper is stripped", () => {
  assert.equal(parsePubkeyInput(`nostr:${npubEncode(HEX)}`), HEX);
  assert.equal(parsePubkeyInput(`NOSTR:${HEX}`), HEX);
});

test("a corrupted npub is rejected rather than decoded to something else", () => {
  const npub = npubEncode(HEX);
  // Flip one data character: bech32's checksum must catch it.
  const broken = `${npub.slice(0, -5)}${npub.at(-5) === "q" ? "p" : "q"}${npub.slice(-4)}`;
  assert.equal(parsePubkeyInput(broken), null);
});

test("near-misses are rejected", () => {
  assert.equal(parsePubkeyInput(""), null);
  assert.equal(parsePubkeyInput("   "), null);
  assert.equal(parsePubkeyInput("alice@example.com"), null);
  assert.equal(parsePubkeyInput(HEX.slice(0, 63)), null, "63 chars");
  assert.equal(parsePubkeyInput(`${HEX}f`), null, "65 chars");
  assert.equal(parsePubkeyInput(`${HEX.slice(0, 63)}z`), null, "not hex");
});

test("a note id is not a pubkey", () => {
  // note1… decodes cleanly but is an event, not a person. Accepting it would
  // send the relay a p tag naming an event id.
  const note = npubEncode(HEX).replace(/^npub/, "note");
  assert.equal(parsePubkeyInput(note), null);
});

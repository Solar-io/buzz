import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, npubEncode } from "nostr-tools/nip19";
import { npubLabel, toNpub } from "./npub.ts";

// A real 32-byte hex key, so the bech32 round-trip is exercised rather than
// mocked. Fixed rather than random: the expected label below is hardcoded, and
// an expectation derived from the code it pins proves nothing.
const PUBKEY =
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const NPUB = npubEncode(PUBKEY);

test("toNpub round-trips a hex key through bech32", () => {
  const npub = toNpub(PUBKEY);
  assert.equal(npub, NPUB);
  assert.ok(npub.startsWith("npub1"));
  const decoded = decode(npub);
  assert.equal(decoded.type, "npub");
  assert.equal(decoded.data, PUBKEY);
});

test("toNpub returns null for anything that is not a full 32-byte hex key", () => {
  assert.equal(toNpub(""), null);
  assert.equal(toNpub("nothex"), null);
  // Regression: nostr-tools encodes this happily (as `npub106246s`), so
  // without the length guard a three-character fragment would be presented as
  // a whole identity.
  assert.equal(toNpub("abc"), null);
  assert.equal(toNpub(PUBKEY.slice(0, 63)), null, "63 hex chars is not a key");
  assert.equal(toNpub(`${PUBKEY}00`), null, "66 hex chars is not a key");
  assert.equal(
    toNpub(PUBKEY.replace(/.$/, "g")),
    null,
    "64 chars with a non-hex digit is not a key",
  );
});

test("npubLabel truncates the npub, not the hex", () => {
  // Hardcoded, not computed from NPUB: the point is that the label is the
  // bech32 form. Deriving it from `npub.slice(...)` would pass even if the
  // implementation truncated the hex instead.
  assert.equal(npubLabel(PUBKEY), "npub180c…h6w6");
  assert.ok(npubLabel(PUBKEY).startsWith("npub1"));
});

test("npubLabel falls back to truncated hex when encoding fails", () => {
  const label = npubLabel("zzzz1111zzzz1111zzzz1111zzzz1111");
  assert.equal(label, "zzzz1111…1111");
  assert.equal(label.startsWith("npub"), false);
});

test("npubLabel leaves an already-short value alone", () => {
  assert.equal(npubLabel("short"), "short");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";
import { nsecFromSecretKey, pairingLink, parseSecretKeyInput } from "./nsec.ts";

const secretKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
const nsec = nsecEncode(secretKey);

test("parses an nsec and returns canonical form", () => {
  const parsed = parseSecretKeyInput(`  ${nsec}  `);
  assert.equal(parsed.ok, true);
  assert.deepEqual(Array.from(parsed.secretKey), Array.from(secretKey));
  assert.equal(parsed.nsec, nsec);
});

test("parses 64-char hex (case-insensitive) to the same key", () => {
  const hex = Array.from(secretKey, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const upper = parseSecretKeyInput(hex.toUpperCase());
  assert.equal(upper.ok, true);
  assert.deepEqual(Array.from(upper.secretKey), Array.from(secretKey));
  assert.equal(upper.nsec, nsec);
});

test("rejects a checksum-corrupted nsec", () => {
  const corrupt = `${nsec.slice(0, -2)}zz`;
  const parsed = parseSecretKeyInput(corrupt);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /checksum/i);
});

test("rejects an npub (public key) as a secret key", () => {
  const hex = Array.from(secretKey, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const pub = npubEncode(hex);
  const parsed = parseSecretKeyInput(pub);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /public key/i);
});

test("rejects junk input", () => {
  for (const junk of ["", "   ", "hello", "abc123"]) {
    const parsed = parseSecretKeyInput(junk);
    assert.equal(
      parsed.ok,
      false,
      `expected rejection for ${JSON.stringify(junk)}`,
    );
  }
});

test("nsecFromSecretKey round-trips through parse", () => {
  const encoded = nsecFromSecretKey(secretKey);
  const parsed = parseSecretKeyInput(encoded);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nsec, encoded);
});

test("parses a pairing link's key from the URL fragment", () => {
  const parsed = parseSecretKeyInput(
    `https://buzz.example.com/repos#nsec=${nsec}`,
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(Array.from(parsed.secretKey), Array.from(secretKey));
  assert.equal(parsed.nsec, nsec);
});

test("parses a pairing link's key from the query string too", () => {
  const parsed = parseSecretKeyInput(
    `https://buzz.example.com/repos?nsec=${nsec}`,
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(Array.from(parsed.secretKey), Array.from(secretKey));
  assert.equal(parsed.nsec, nsec);
});

test("rejects a link that carries no pairing key", () => {
  const parsed = parseSecretKeyInput("https://buzz.example.com/repos#about");
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /does not carry/i);
});

test("rejects a pairing link with a checksum-corrupted key", () => {
  const corrupt = `${nsec.slice(0, -2)}zz`;
  const parsed = parseSecretKeyInput(
    `https://buzz.example.com/repos#nsec=${corrupt}`,
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /checksum/i);
});

test("pairingLink builds an app URL that parses back to the same key", () => {
  const link = pairingLink("https://buzz.example.com", secretKey);
  assert.ok(
    link.startsWith("https://buzz.example.com/repos#nsec="),
    `unexpected link shape: ${link}`,
  );
  const parsed = parseSecretKeyInput(link);
  assert.equal(parsed.ok, true);
  assert.deepEqual(Array.from(parsed.secretKey), Array.from(secretKey));
  assert.equal(parsed.nsec, nsec);
});

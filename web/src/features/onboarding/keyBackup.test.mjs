/**
 * The restore-test, exercised against real NIP-49 ciphertext.
 *
 * `verifyBackupRestores` is the step that makes a backup worth having, and its
 * most important branch — "this file opens a DIFFERENT identity" — cannot be
 * reached from the card's own UI, which only ever verifies the blob it just
 * produced. So it is pinned here instead.
 *
 * This file loads the production module (not a copy) and encrypts with the
 * real library, so a change to the work factor, the encoding, or the pubkey
 * comparison all show up.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  decryptNcryptsec,
  encryptSecretKeyToNcryptsec,
  verifyBackupRestores,
} from "./keyBackup.ts";

const PASSPHRASE = "a-good-backup-passphrase";

test("a key round-trips through encrypt and decrypt unchanged", () => {
  const secretKey = generateSecretKey();
  const blob = encryptSecretKeyToNcryptsec(secretKey, PASSPHRASE);
  const restored = decryptNcryptsec(blob, PASSPHRASE);
  assert.deepEqual(Array.from(restored), Array.from(secretKey));
});

test("the ciphertext is a 162-character ncryptsec1 string", () => {
  const blob = encryptSecretKeyToNcryptsec(generateSecretKey(), PASSPHRASE);
  assert.equal(blob.startsWith("ncryptsec1"), true);
  assert.equal(blob.length, 162);
});

test("two encryptions of the same key differ (the salt is random)", () => {
  const secretKey = generateSecretKey();
  assert.notEqual(
    encryptSecretKeyToNcryptsec(secretKey, PASSPHRASE),
    encryptSecretKeyToNcryptsec(secretKey, PASSPHRASE),
  );
});

test("a wrong passphrase throws a message a person can act on", () => {
  const blob = encryptSecretKeyToNcryptsec(generateSecretKey(), PASSPHRASE);
  assert.throws(
    () => decryptNcryptsec(blob, "not-the-passphrase"),
    /Wrong passphrase, or the backup is damaged\./,
  );
});

test("surrounding whitespace does not stop a decrypt", () => {
  const secretKey = generateSecretKey();
  const blob = encryptSecretKeyToNcryptsec(secretKey, PASSPHRASE);
  assert.deepEqual(
    Array.from(decryptNcryptsec(`\n  ${blob}  \n`, PASSPHRASE)),
    Array.from(secretKey),
  );
});

test("a backup of this identity verifies", () => {
  const secretKey = generateSecretKey();
  const blob = encryptSecretKeyToNcryptsec(secretKey, PASSPHRASE);
  assert.deepEqual(
    verifyBackupRestores(blob, PASSPHRASE, getPublicKey(secretKey)),
    { ok: true },
  );
});

test("a wrong passphrase fails verification rather than throwing", () => {
  const secretKey = generateSecretKey();
  const blob = encryptSecretKeyToNcryptsec(secretKey, PASSPHRASE);
  const result = verifyBackupRestores(blob, "nope", getPublicKey(secretKey));
  assert.equal(result.ok, false);
  assert.match(result.reason, /Wrong passphrase/);
});

/**
 * The branch the UI cannot reach. Both blobs decrypt perfectly and both
 * passphrases are right — only the identity differs, so an implementation that
 * checked "does it decrypt?" and stopped would call this a good backup and let
 * someone file away the key to an account they no longer use.
 */
test("a valid backup of a DIFFERENT identity is rejected", () => {
  const mine = generateSecretKey();
  const theirs = generateSecretKey();
  const theirBlob = encryptSecretKeyToNcryptsec(theirs, PASSPHRASE);
  // It genuinely decrypts — the rejection is not a decrypt failure.
  assert.deepEqual(
    Array.from(decryptNcryptsec(theirBlob, PASSPHRASE)),
    Array.from(theirs),
  );
  const result = verifyBackupRestores(
    theirBlob,
    PASSPHRASE,
    getPublicKey(mine),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /different identity/);
});

test("the pubkey comparison ignores case", () => {
  const secretKey = generateSecretKey();
  const blob = encryptSecretKeyToNcryptsec(secretKey, PASSPHRASE);
  assert.deepEqual(
    verifyBackupRestores(
      blob,
      PASSPHRASE,
      getPublicKey(secretKey).toUpperCase(),
    ),
    { ok: true },
  );
});

test("a malformed blob fails verification with a reason", () => {
  const result = verifyBackupRestores("ncryptsec1nonsense", PASSPHRASE, "ab");
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

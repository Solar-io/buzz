import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PBKDF2_ITERATIONS,
  decryptSecretKey,
  encryptSecretKey,
  isValidEnvelope,
} from "./key-crypto.ts";

const subtle = globalThis.crypto.subtle;

function randomKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** Independently decrypt an envelope with raw webcrypto (no module code). */
async function independentDecrypt(envelope, passphrase) {
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: Buffer.from(envelope.salt, "hex"),
      iterations: envelope.iterations,
    },
    baseKey,
    256,
  );
  const aesKey = await subtle.importKey(
    "raw",
    bits,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "hex") },
    aesKey,
    Buffer.from(envelope.ct, "hex"),
  );
  return new Uint8Array(plain);
}

test("roundtrip: decrypt returns the exact key bytes", async () => {
  const key = randomKey();
  const envelope = await encryptSecretKey(key, "correct horse battery");
  const opened = await decryptSecretKey(envelope, "correct horse battery");
  assert.deepEqual(Array.from(opened), Array.from(key));
});

test("envelope format matches raw AES-GCM/PBKDF2 (independent decrypt)", async () => {
  const key = randomKey();
  const envelope = await encryptSecretKey(key, "pass-123");
  const opened = await independentDecrypt(envelope, "pass-123");
  assert.deepEqual(Array.from(opened), Array.from(key));
});

test("wrong passphrase rejects", async () => {
  const envelope = await encryptSecretKey(randomKey(), "right");
  await assert.rejects(
    decryptSecretKey(envelope, "wrong"),
    /OperationError|decrypt/i,
  );
});

test("tampered ciphertext rejects (GCM auth tag)", async () => {
  const envelope = await encryptSecretKey(randomKey(), "pass");
  const ctBytes = Buffer.from(envelope.ct, "hex");
  ctBytes[ctBytes.length - 1] ^= 1;
  const tampered = { ...envelope, ct: ctBytes.toString("hex") };
  await assert.rejects(decryptSecretKey(tampered, "pass"));
});

test("two seals of the same key use different salt and iv", async () => {
  const key = randomKey();
  const a = await encryptSecretKey(key, "pass");
  const b = await encryptSecretKey(key, "pass");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test("envelope pins the OWASP iteration count literally", async () => {
  const envelope = await encryptSecretKey(randomKey(), "pass");
  assert.equal(envelope.iterations, 600000);
  assert.equal(PBKDF2_ITERATIONS, 600000);
});

test("input validation", async () => {
  await assert.rejects(
    encryptSecretKey(new Uint8Array(31), "pass"),
    /32 bytes/,
  );
  await assert.rejects(encryptSecretKey(randomKey(), ""), /passphrase/);
  await assert.rejects(decryptSecretKey({ ...{ v: 2 } }, "pass"), /version/);
});

test("isValidEnvelope shape checks", async () => {
  const envelope = await encryptSecretKey(randomKey(), "pass");
  assert.equal(isValidEnvelope(envelope), true);
  assert.equal(isValidEnvelope(null), false);
  assert.equal(isValidEnvelope("x"), false);
  assert.equal(isValidEnvelope({ ...envelope, ct: "zz" }), false);
  assert.equal(isValidEnvelope({ ...envelope, iterations: 0 }), false);
  assert.equal(isValidEnvelope({ ...envelope, iv: "abcd" }), false);
});

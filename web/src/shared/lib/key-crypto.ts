/**
 * Envelope encryption for the local identity key.
 *
 * The secret key is sealed with AES-GCM under a passphrase-derived key
 * (PBKDF2-HMAC-SHA256, per OWASP 2023 iteration guidance). The envelope is
 * self-describing so the scheme can evolve without migrating storage keys.
 *
 * `crypto` is injectable so unit tests can pass an explicit webcrypto
 * instance under node:test (node has webcrypto; it lacks IndexedDB, which
 * key-store.ts abstracts separately).
 */

export interface KeyEnvelope {
  v: 1;
  /** Hex-encoded PBKDF2 salt. */
  salt: string;
  /** PBKDF2 iteration count. */
  iterations: number;
  /** Hex-encoded AES-GCM IV. */
  iv: string;
  /** Hex-encoded ciphertext of the 32-byte secret key. */
  ct: string;
}

export interface KeyCryptoDeps {
  subtle: SubtleCrypto;
  randomBytes: (n: number) => Uint8Array<ArrayBuffer>;
}

export const PBKDF2_ITERATIONS = 600_000;

const encoder = new TextEncoder();

export function defaultKeyCryptoDeps(): KeyCryptoDeps {
  const c = globalThis.crypto;
  return {
    subtle: c.subtle,
    randomBytes: (n) => c.getRandomValues(new Uint8Array(n)),
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(out[i])) {
      throw new Error("invalid hex");
    }
  }
  return out;
}

async function deriveAesKey(
  deps: KeyCryptoDeps,
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await deps.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await deps.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    256,
  );
  return deps.subtle.importKey(
    "raw",
    bits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal a 32-byte secret key under `passphrase`. */
export async function encryptSecretKey(
  secretKey: Uint8Array<ArrayBuffer>,
  passphrase: string,
  deps: KeyCryptoDeps = defaultKeyCryptoDeps(),
): Promise<KeyEnvelope> {
  if (secretKey.length !== 32) {
    throw new Error(`secret key must be 32 bytes, got ${secretKey.length}`);
  }
  if (passphrase.length === 0) {
    throw new Error("passphrase must not be empty");
  }
  const salt = deps.randomBytes(16);
  const iv = deps.randomBytes(12);
  const key = await deriveAesKey(deps, passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await deps.subtle.encrypt({ name: "AES-GCM", iv }, key, secretKey);
  return {
    v: 1,
    salt: toHex(salt),
    iterations: PBKDF2_ITERATIONS,
    iv: toHex(iv),
    ct: toHex(new Uint8Array(ct)),
  };
}

/** Open an envelope. Rejects on wrong passphrase or tampered ciphertext. */
export async function decryptSecretKey(
  envelope: KeyEnvelope,
  passphrase: string,
  deps: KeyCryptoDeps = defaultKeyCryptoDeps(),
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.v !== 1) {
    throw new Error(`unsupported envelope version ${envelope.v}`);
  }
  const key = await deriveAesKey(
    deps,
    passphrase,
    fromHex(envelope.salt),
    envelope.iterations,
  );
  const plain = await deps.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(envelope.iv) },
    key,
    fromHex(envelope.ct),
  );
  const secret = new Uint8Array(plain);
  if (secret.length !== 32) {
    throw new Error(`decrypted key must be 32 bytes, got ${secret.length}`);
  }
  return secret;
}

export function isValidEnvelope(value: unknown): value is KeyEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const env = value as Record<string, unknown>;
  return (
    env.v === 1 &&
    typeof env.salt === "string" &&
    env.salt.length === 32 &&
    typeof env.iterations === "number" &&
    Number.isInteger(env.iterations) &&
    env.iterations > 0 &&
    typeof env.iv === "string" &&
    env.iv.length === 24 &&
    typeof env.ct === "string" &&
    // 32-byte key + 16-byte GCM auth tag.
    env.ct.length === 96
  );
}

/**
 * Local identity-key store: persistent envelope + optional remembered key.
 *
 * - Persisted: the AES-GCM envelope (key-crypto) in IndexedDB.
 * - Remembered device (default ON): the raw secret key also stored in
 *   IndexedDB so a page refresh stays signed in (Sam's ask, 8/31). This is
 *   strictly weaker at rest than passphrase-only — anyone with this browser
 *   profile's storage can extract the key. "Forget this device" clears it;
 *   turning "stay signed in" off in Settings removes it while keeping the
 *   passphrase envelope.
 * - Session: the raw secret key lives in module memory; without the
 *   remembered key, "locked" means reloading clears it and the user
 *   re-enters the passphrase.
 *
 * A tiny event emitter lets React hooks re-render on auth-state changes
 * without a state library.
 */

import { get, set, del } from "idb-keyval";
import {
  type KeyEnvelope,
  decryptSecretKey,
  encryptSecretKey,
  isValidEnvelope,
} from "./key-crypto.ts";

const ENVELOPE_KEY = "buzz.identity-envelope.v1";
const AUTH_TAG_KEY = "buzz.auth-tag.v1";
const REMEMBERED_KEY = "buzz.session-key.v1";
const NO_PASSPHRASE_KEY = "buzz.no-passphrase.v1";

/** Stored shape for the remembered-device key: bytes + the hint it must match. */
export interface RememberedKey {
  /** Raw 32-byte secret key (ArrayBuffer in IndexedDB). */
  bytes: Uint8Array<ArrayBuffer>;
  /** Envelope hint at remember time — a stale key fails this cheap check. */
  hint: string;
}

/**
 * Pure validation for the remembered key: 32 bytes AND the hint recorded at
 * remember time matches the hint of the key being restored. A mismatch means
 * the envelope was re-enrolled under a different key after this was written.
 */
export function isValidRememberedKey(
  value: unknown,
  hintOf: (bytes: Uint8Array) => string,
): value is RememberedKey {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { bytes?: unknown; hint?: unknown };
  if (!(record.bytes instanceof Uint8Array) || record.bytes.length !== 32) {
    return false;
  }
  if (typeof record.hint !== "string" || record.hint.length === 0) {
    return false;
  }
  return hintOf(record.bytes) === record.hint;
}

/**
 * NIP-OA agent attestation (["auth","<attestation>"] as a JSON string).
 * Public-verifiable owner signature — carries no secret, so it is stored
 * plainly next to the encrypted envelope; it only matters WITH its key.
 */
let authTagJson: string | null = null;

export type AuthState =
  | { status: "anonymous" }
  | { status: "locked"; envelope: KeyEnvelope }
  | { status: "unlocked"; source: "local"; pubkeyHint: string };

type Listener = (state: AuthState) => void;

let authState: AuthState = { status: "anonymous" };
let unlockedSecretKey: Uint8Array<ArrayBuffer> | null = null;
const listeners = new Set<Listener>();

function setState(next: AuthState) {
  authState = next;
  for (const listener of listeners) {
    listener(next);
  }
}

export function getAuthState(): AuthState {
  return authState;
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Load the envelope (if any) from IndexedDB and derive the initial state. */
export async function initKeyStore(): Promise<void> {
  try {
    const storedTag = await get(AUTH_TAG_KEY);
    if (typeof storedTag === "string" && storedTag.length > 0) {
      authTagJson = storedTag;
    }
  } catch {
    // Storage unavailable — tag simply stays unset.
  }
  try {
    const stored = await get(ENVELOPE_KEY);
    if (isValidEnvelope(stored)) {
      setState(
        authState.status === "unlocked"
          ? authState
          : { status: "locked", envelope: stored },
      );
    }
  } catch {
    // Storage unavailable (private mode etc.): stay anonymous.
  }
  // Remembered device: restore the key so a refresh stays signed in. Only
  // when the envelope exists AND the remembered key still matches it.
  try {
    const remembered = await get(REMEMBERED_KEY);
    if (
      authState.status === "locked" &&
      isValidRememberedKey(remembered, hintFromKey)
    ) {
      const keyBytes = new Uint8Array(remembered.bytes.length);
      keyBytes.set(remembered.bytes);
      unlockedSecretKey = keyBytes;
      setState({
        status: "unlocked",
        source: "local",
        pubkeyHint: remembered.hint,
      });
    }
  } catch {
    // Storage unavailable — the passphrase path still works.
  }
}

export function setAuthTagJson(tag: string | null): void {
  authTagJson = tag;
  if (tag === null) {
    void del(AUTH_TAG_KEY);
  } else {
    void set(AUTH_TAG_KEY, tag);
  }
}

/** The stored NIP-OA attestation, or null for direct-member (human) auth. */
export function getAuthTagJson(): string | null {
  return authTagJson;
}

/** True when a raw secret key is held in memory for this page session. */
export function hasUnlockedKey(): boolean {
  return unlockedSecretKey !== null;
}

/** The unlocked raw key, or null when locked/anonymous. */
export function getUnlockedSecretKey(): Uint8Array<ArrayBuffer> | null {
  return unlockedSecretKey;
}

/** Persist the key for refresh-surviving unlock on this device (default on). */
async function rememberSecretKey(secretKey: Uint8Array): Promise<void> {
  const keyBytes = new Uint8Array(secretKey.length);
  keyBytes.set(secretKey);
  await set(REMEMBERED_KEY, {
    bytes: keyBytes,
    hint: hintFromKey(keyBytes),
  });
}

/** Settings-toggle entry: re-enable stay-signed-in for the current key. */
export async function rememberSecretKeyForSettings(
  secretKey: Uint8Array,
): Promise<void> {
  await rememberSecretKey(secretKey);
}

/** Remove the remembered key; the passphrase envelope stays for unlock. */
export async function clearRememberedKey(): Promise<void> {
  await del(REMEMBERED_KEY);
}

/** True when a remembered key row exists (for the Settings toggle state). */
export async function hasRememberedKey(): Promise<boolean> {
  try {
    const remembered = await get(REMEMBERED_KEY);
    return isValidRememberedKey(remembered, hintFromKey);
  } catch {
    return false;
  }
}

/**
 * Store a new secret key: seal it under `passphrase`, persist, and unlock.
 * Overwrites any previous envelope (one local identity at a time).
 */
export async function enrollSecretKey(
  secretKey: Uint8Array,
  passphrase: string,
): Promise<void> {
  // Copy into a fresh ArrayBuffer-backed array at the boundary so callers
  // cannot observe later mutation of the source buffer.
  const keyBytes = new Uint8Array(secretKey.length);
  keyBytes.set(secretKey);
  const envelope = await encryptSecretKey(keyBytes, passphrase);
  await set(ENVELOPE_KEY, envelope);
  await set(AUTH_TAG_KEY, authTagJson ?? "");
  await set(NO_PASSPHRASE_KEY, false);
  try {
    await rememberSecretKey(keyBytes);
  } catch {
    // Remembering is best-effort; the envelope unlock still works.
  }
  unlockedSecretKey = keyBytes;
  setState({
    status: "unlocked",
    source: "local",
    pubkeyHint: hintFromKey(keyBytes),
  });
}

/**
 * QR-pairing enroll: seal under a device-generated passphrase nobody ever
 * types. Scanning a pairing QR signs the device straight in (Sam's ask,
 * 9/3) — with the remembered key on by default the passphrase ceremony
 * bought nothing. Marks the device no-passphrase so Settings knows that
 * turning stay-signed-in off must sign out rather than lock out.
 */
export async function enrollSecretKeyFromPairing(
  secretKey: Uint8Array,
): Promise<void> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const passphrase = Array.from(random, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await enrollSecretKey(secretKey, passphrase);
  await set(NO_PASSPHRASE_KEY, true);
}

/** True when this device's envelope is sealed under a generated (unknown
 * to the user) passphrase — i.e. it was paired by QR. */
export async function hasNoPassphrase(): Promise<boolean> {
  try {
    return (await get(NO_PASSPHRASE_KEY)) === true;
  } catch {
    return false;
  }
}

/** Unlock the persisted envelope with its passphrase. */
export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  const stored = await get(ENVELOPE_KEY);
  if (!isValidEnvelope(stored)) {
    throw new Error("No stored key on this device.");
  }
  const secretKey = await decryptSecretKey(stored, passphrase);
  try {
    await rememberSecretKey(secretKey);
  } catch {
    // Best-effort: refresh-persistence just won't work until next unlock.
  }
  unlockedSecretKey = secretKey;
  setState({
    status: "unlocked",
    source: "local",
    pubkeyHint: hintFromKey(secretKey),
  });
}

/** Drop the in-memory key. The envelope stays; passphrase re-unlocks. */
export function lockNow(): void {
  unlockedSecretKey = null;
  void (async () => {
    try {
      const stored = await get(ENVELOPE_KEY);
      setState(
        isValidEnvelope(stored)
          ? { status: "locked", envelope: stored }
          : { status: "anonymous" },
      );
      // A remembered key re-unlocks immediately — lock with remember = no-op
      // for privacy; use "Forget this device" or the toggle for a real exit.
      if (authState.status === "locked") {
        try {
          const remembered = await get(REMEMBERED_KEY);
          if (isValidRememberedKey(remembered, hintFromKey)) {
            const keyBytes = new Uint8Array(remembered.bytes.length);
            keyBytes.set(remembered.bytes);
            unlockedSecretKey = keyBytes;
            setState({
              status: "unlocked",
              source: "local",
              pubkeyHint: remembered.hint,
            });
          }
        } catch {
          // Stay locked.
        }
      }
    } catch {
      setState({ status: "anonymous" });
    }
  })();
}

/** Forget this device entirely: clear envelope, remembered key, and memory. */
export async function signOut(): Promise<void> {
  unlockedSecretKey = null;
  authTagJson = null;
  await del(ENVELOPE_KEY);
  await del(AUTH_TAG_KEY);
  await del(REMEMBERED_KEY);
  await del(NO_PASSPHRASE_KEY);
  setState({ status: "anonymous" });
}

function hintFromKey(secretKey: Uint8Array): string {
  // Cheap, dependency-free disambiguator for the settings screen; the real
  // pubkey derivation lives in the signer and is not needed here.
  let h = 0;
  for (const b of secretKey) {
    h = (Math.imul(h, 31) + b) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

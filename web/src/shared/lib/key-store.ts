/**
 * Local identity-key store: persistent envelope + in-memory unlock.
 *
 * - Persisted: the AES-GCM envelope (key-crypto) in IndexedDB, never the key.
 * - Session: the raw secret key lives only in module memory; "locked" means
 *   reloading the page clears it and the user re-enters the passphrase.
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
}

/** True when a raw secret key is held in memory for this page session. */
export function hasUnlockedKey(): boolean {
  return unlockedSecretKey !== null;
}

/** The unlocked raw key, or null when locked/anonymous. */
export function getUnlockedSecretKey(): Uint8Array<ArrayBuffer> | null {
  return unlockedSecretKey;
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
  unlockedSecretKey = keyBytes;
  setState({
    status: "unlocked",
    source: "local",
    pubkeyHint: hintFromKey(keyBytes),
  });
}

/** Unlock the persisted envelope with its passphrase. */
export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  const stored = await get(ENVELOPE_KEY);
  if (!isValidEnvelope(stored)) {
    throw new Error("No stored key on this device.");
  }
  const secretKey = await decryptSecretKey(stored, passphrase);
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
    } catch {
      setState({ status: "anonymous" });
    }
  })();
}

/** Forget this device entirely: clear envelope and memory. */
export async function signOut(): Promise<void> {
  unlockedSecretKey = null;
  await del(ENVELOPE_KEY);
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

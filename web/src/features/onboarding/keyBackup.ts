/**
 * NIP-49 encrypted key backup, and the record of whether one exists.
 *
 * The desktop encrypts in Rust and writes a file the user picks. A browser
 * cannot choose a folder, so this delegates to `nostr-tools/nip49` — the same
 * key-derivation and AEAD construction NIP-49 specifies, producing the same
 * `ncryptsec1…` string the desktop reads — and hands the result over as a
 * download. No cryptography is implemented in this file; it calls the library
 * and manages the resulting blob.
 *
 * **The blob is never sent anywhere.** The desktop enforces that with an
 * egress guard (`src-tauri/src/egress_guard.rs`) that refuses to transmit any
 * text containing `ncryptsec1`. There is no equivalent chokepoint here — a web
 * client's network calls are spread across features — so the rule is kept by
 * construction instead: the ciphertext is produced in this module, handed to
 * the DOM download path, and held in React state that no publish path reads.
 * If you ever find yourself passing an `ncryptsec` to a relay call, that is
 * the bug this note exists to name.
 */

import { get, set, del } from "idb-keyval";
import {
  decrypt as nip49Decrypt,
  encrypt as nip49Encrypt,
} from "nostr-tools/nip49";
import { getPublicKey } from "nostr-tools/pure";

/**
 * Work factor for NIP-49's key derivation. 16 is `nostr-tools`' own default
 * and what the desktop's `nostr` crate uses, so a backup made here costs the
 * same to open there. Raising it would still interoperate but would make the
 * desktop's unlock slower for no stated reason.
 */
const LOG_N = 16;

const BACKUP_RECORD_KEY = "buzz.key-backup-record.v1";

export interface BackupRecord {
  /** ISO timestamp of the most recent backup download on this device. */
  createdAt: string;
  /** The pubkey it covers — a backup of a previous identity does not count. */
  pubkey: string;
}

/**
 * Whether this device has a recorded backup for `pubkey`.
 *
 * Keyed by pubkey on purpose: after re-enrolling a different key, the old
 * record must not tick the checklist for the new identity.
 */
export async function hasBackupFor(pubkey: string | null): Promise<boolean> {
  if (!pubkey) return false;
  try {
    const record = (await get(BACKUP_RECORD_KEY)) as BackupRecord | undefined;
    return record?.pubkey?.toLowerCase() === pubkey.toLowerCase();
  } catch {
    return false;
  }
}

export async function readBackupRecord(): Promise<BackupRecord | null> {
  try {
    return ((await get(BACKUP_RECORD_KEY)) as BackupRecord | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Record that a backup was downloaded. Called only after the download fires. */
export async function recordBackup(pubkey: string): Promise<void> {
  try {
    await set(BACKUP_RECORD_KEY, {
      createdAt: new Date().toISOString(),
      pubkey: pubkey.toLowerCase(),
    } satisfies BackupRecord);
  } catch {
    // Best effort — the file is the backup; this only drives the checklist.
  }
}

export async function clearBackupRecord(): Promise<void> {
  try {
    await del(BACKUP_RECORD_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Encrypt a secret key to `ncryptsec1…`. */
export function encryptSecretKeyToNcryptsec(
  secretKey: Uint8Array,
  passphrase: string,
): string {
  return nip49Encrypt(secretKey, passphrase, LOG_N);
}

/**
 * Decrypt an `ncryptsec1…` back to raw key bytes.
 *
 * Throws with a plain message on a wrong passphrase — the underlying error is
 * an AEAD tag failure, which is accurate and useless to a person.
 */
export function decryptNcryptsec(
  ncryptsec: string,
  passphrase: string,
): Uint8Array {
  try {
    return nip49Decrypt(ncryptsec.trim(), passphrase);
  } catch {
    throw new Error("Wrong passphrase, or the backup is damaged.");
  }
}

/**
 * Restore-test a backup: decrypt it and check it yields the SAME identity.
 *
 * This is the step that makes a backup worth having. Decrypting proves the
 * passphrase; comparing the derived pubkey proves the file is a backup of
 * *this* identity and not an older one the user still had lying around — the
 * failure that is invisible until the day it matters.
 */
export function verifyBackupRestores(
  ncryptsec: string,
  passphrase: string,
  expectedPubkey: string,
): { ok: true } | { ok: false; reason: string } {
  let restored: Uint8Array;
  try {
    restored = decryptNcryptsec(ncryptsec, passphrase);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Could not decrypt.",
    };
  }
  const pubkey = getPublicKey(restored);
  if (pubkey.toLowerCase() !== expectedPubkey.toLowerCase()) {
    return {
      ok: false,
      reason:
        "That backup opens a different identity than the one signed in here.",
    };
  }
  return { ok: true };
}

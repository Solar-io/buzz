/**
 * The encrypted-backup file: naming, body, and reading one back.
 *
 * A browser cannot write to a folder of the user's choosing, so the desktop's
 * "save your key somewhere safe" step becomes a download. The body is
 * deliberately a plain text file whose FIRST non-comment line is the
 * `ncryptsec1…` blob, for two reasons: the desktop's import box accepts that
 * string directly, and a person who opens the file in six months can see what
 * it is without a tool.
 *
 * `parseBackupFile` is the mirror — it tolerates the comment header, stray
 * blank lines, and a bare blob with no header at all.
 *
 * Import-free so `node --test` can load it.
 */

export const MIN_BACKUP_PASSPHRASE_LEN = 12;

/**
 * The desktop's own minimum, from `onboarding/lib/encryptedBackup.ts`. It is
 * higher than the 8 the login gate asks for, and deliberately so: this
 * passphrase guards a file that leaves the device, where an attacker can
 * grind at it offline for as long as they like.
 */
export function backupPassphraseIssue(passphrase: string): string | null {
  if (passphrase.length === 0) return null;
  return [...passphrase].length < MIN_BACKUP_PASSPHRASE_LEN
    ? `Use at least ${MIN_BACKUP_PASSPHRASE_LEN} characters.`
    : null;
}

/** Whether the passphrase is long enough to encrypt with. */
export function backupPassphraseReady(passphrase: string): boolean {
  return [...passphrase].length >= MIN_BACKUP_PASSPHRASE_LEN;
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * `buzz-key-backup-YYYY-MM-DD.txt`, using LOCAL date parts.
 *
 * Local rather than UTC on purpose: the name is a label for a human filing a
 * file, and a backup made at 9pm on the 3rd should not be filed under the 4th.
 */
export function backupFileName(now: Date): string {
  return `buzz-key-backup-${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}.txt`;
}

/**
 * The file body. The header explains the file; the blob stands alone on its
 * own line so a copy-paste of that line is a valid import anywhere.
 */
export function backupFileBody(ncryptsec: string, now: Date): string {
  return [
    "# Buzz identity backup (NIP-49)",
    "#",
    "# This is your Nostr secret key, encrypted with the passphrase you chose.",
    "# Anyone with this file AND that passphrase can sign as you. Anyone with",
    "# only this file cannot.",
    "#",
    "# To restore: open Buzz, choose 'Enter key manually', and paste the line",
    "# below. Buzz Desktop accepts the same line.",
    `# Created: ${now.toISOString()}`,
    "",
    ncryptsec,
    "",
  ].join("\n");
}

/**
 * Pull the `ncryptsec1…` blob out of a backup file's text.
 *
 * Scans every line rather than assuming a position, so a file that has been
 * re-saved, re-wrapped by a mail client, or hand-annotated still restores.
 * Returns null when nothing in the text looks like a blob.
 */
export function parseBackupFile(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = line.match(/(ncryptsec1[02-9ac-hj-np-z]+)/i);
    if (match) return match[1].toLowerCase();
    // A non-comment line that is not a blob: keep scanning rather than
    // failing, since notes above or below the blob are normal.
  }
  return null;
}

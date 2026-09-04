import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backupFileBody,
  backupFileName,
  backupPassphraseIssue,
  backupPassphraseReady,
  MIN_BACKUP_PASSPHRASE_LEN,
  parseBackupFile,
} from "./backupFile.ts";
import {
  buildChecklist,
  checklistProgress,
  shouldShowChecklist,
} from "./onboardingChecklist.ts";
import {
  classifyKeyImportInput,
  isPlausibleNcryptsec,
  isPlausibleNsec,
  keyImportSubmitEnabled,
  NCRYPTSEC_ENCODED_LENGTH,
} from "./keyImportInput.ts";

/** The NIP-49 spec vector, as used by the desktop's egress-guard tests. */
const NCRYPTSEC =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";
/** A real nsec, generated once and pinned so the check is not self-referential. */
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

// ── key import classification ───────────────────────────────────────────────

test("the spec vector is exactly the documented encoded length", () => {
  assert.equal(NCRYPTSEC.length, NCRYPTSEC_ENCODED_LENGTH);
  assert.equal(NCRYPTSEC_ENCODED_LENGTH, 162);
});

test("an ncryptsec is classified as ncryptsec", () => {
  assert.equal(classifyKeyImportInput(NCRYPTSEC), "ncryptsec");
});

test("classification is case-insensitive on the HRP", () => {
  assert.equal(classifyKeyImportInput(NCRYPTSEC.toUpperCase()), "ncryptsec");
});

test("an nsec is classified as nsec", () => {
  assert.equal(classifyKeyImportInput(NSEC), "nsec");
});

test("an npub is neither", () => {
  assert.equal(classifyKeyImportInput("npub1abc"), "unknown");
});

test("leading and trailing whitespace does not change the verdict", () => {
  assert.equal(classifyKeyImportInput(`  ${NSEC}\n`), "nsec");
});

test("the spec vector passes the structural NIP-49 check", () => {
  assert.equal(isPlausibleNcryptsec(NCRYPTSEC), true);
});

/**
 * The checksum has to be checked, not just the length and prefix. Flipping one
 * data character keeps both intact, so a prefix-and-length implementation
 * would still say yes here.
 */
test("a one-character corruption fails the Bech32 checksum", () => {
  const flipped = `${NCRYPTSEC.slice(0, 20)}${NCRYPTSEC[20] === "q" ? "p" : "q"}${NCRYPTSEC.slice(21)}`;
  assert.equal(flipped.length, NCRYPTSEC.length);
  assert.equal(isPlausibleNcryptsec(flipped), false);
});

test("a truncated blob fails on length", () => {
  assert.equal(isPlausibleNcryptsec(NCRYPTSEC.slice(0, -1)), false);
});

test("mixed case is refused, uppercase is accepted", () => {
  assert.equal(isPlausibleNcryptsec(NCRYPTSEC.toUpperCase()), true);
  const mixed = `NCRYPTSEC1${NCRYPTSEC.slice(10)}`;
  assert.equal(isPlausibleNcryptsec(mixed), false);
});

test("a real nsec passes the nsec structural check", () => {
  assert.equal(isPlausibleNsec(NSEC), true);
});

test("a corrupted nsec fails it", () => {
  const flipped = `${NSEC.slice(0, 10)}${NSEC[10] === "q" ? "p" : "q"}${NSEC.slice(11)}`;
  assert.equal(isPlausibleNsec(flipped), false);
});

test("an ncryptsec is not a valid nsec", () => {
  assert.equal(isPlausibleNsec(NCRYPTSEC), false);
});

// ── submit gating ───────────────────────────────────────────────────────────

/**
 * The passphrase requirement is what discriminates the two branches: the SAME
 * empty passphrase enables submit for an nsec and blocks it for an ncryptsec.
 */
test("an ncryptsec needs a passphrase; an nsec does not", () => {
  assert.equal(keyImportSubmitEnabled(NCRYPTSEC, ""), false);
  assert.equal(keyImportSubmitEnabled(NCRYPTSEC, "x"), true);
  assert.equal(keyImportSubmitEnabled(NSEC, ""), true);
});

test("garbage never enables submit, passphrase or not", () => {
  assert.equal(keyImportSubmitEnabled("hello", ""), false);
  assert.equal(keyImportSubmitEnabled("hello", "passphrase"), false);
});

// ── backup file ─────────────────────────────────────────────────────────────

test("the backup minimum is 12, above the login gate's 8", () => {
  assert.equal(MIN_BACKUP_PASSPHRASE_LEN, 12);
});

test("an empty passphrase reports no issue yet", () => {
  assert.equal(backupPassphraseIssue(""), null);
});

test("a short passphrase is refused and a 12-character one is not", () => {
  assert.equal(
    backupPassphraseIssue("elevenchars"),
    "Use at least 12 characters.",
  );
  assert.equal(backupPassphraseIssue("twelvechars!"), null);
  assert.equal(backupPassphraseReady("twelvechars!"), true);
  assert.equal(backupPassphraseReady("elevenchars"), false);
});

test("length is counted in code points, not UTF-16 units", () => {
  // Twelve astral emoji: 24 UTF-16 units, 12 characters. A .length check
  // would wrongly accept six of them.
  assert.equal(backupPassphraseReady("🐝".repeat(12)), true);
  assert.equal(backupPassphraseReady("🐝".repeat(6)), false);
});

test("the file name uses local date parts", () => {
  // Local-midnight construction, so the assertion holds in any zone.
  assert.equal(
    backupFileName(new Date(2026, 8, 4)),
    "buzz-key-backup-2026-09-04.txt",
  );
});

test("months and days are zero-padded", () => {
  assert.equal(
    backupFileName(new Date(2026, 0, 7)),
    "buzz-key-backup-2026-01-07.txt",
  );
});

test("the blob is on its own line in the body", () => {
  const body = backupFileBody(NCRYPTSEC, new Date(0));
  assert.ok(body.split("\n").includes(NCRYPTSEC));
});

test("the body round-trips through the parser", () => {
  assert.equal(
    parseBackupFile(backupFileBody(NCRYPTSEC, new Date(0))),
    NCRYPTSEC,
  );
});

test("a bare blob with no header parses", () => {
  assert.equal(parseBackupFile(NCRYPTSEC), NCRYPTSEC);
});

test("the parser skips comments and blank lines", () => {
  assert.equal(
    parseBackupFile(`# a note\n\n   \n${NCRYPTSEC}\n# trailing note\n`),
    NCRYPTSEC,
  );
});

test("the parser survives a hand-annotated file", () => {
  assert.equal(
    parseBackupFile(`my buzz key, work laptop\n${NCRYPTSEC}\n`),
    NCRYPTSEC,
  );
});

test("an uppercase blob is normalised on read", () => {
  assert.equal(parseBackupFile(NCRYPTSEC.toUpperCase()), NCRYPTSEC);
});

test("a file with no blob parses to null", () => {
  assert.equal(parseBackupFile("# just a header\nnothing here\n"), null);
});

// ── checklist ───────────────────────────────────────────────────────────────

function facts(overrides = {}) {
  return {
    hasDisplayName: false,
    hasKeyBackup: false,
    notificationsDecided: false,
    themeChosen: false,
    inAChannel: false,
    usesLocalKey: true,
    ...overrides,
  };
}

test("a fresh local-key identity gets five items", () => {
  const items = buildChecklist(facts());
  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((item) => item.id),
    ["profile", "backup", "channel", "notifications", "theme"],
  );
});

/**
 * An extension holds its own key, so "export the key Buzz has" is advice the
 * user cannot act on. Asserting the COUNT as well as the absence catches an
 * implementation that dropped the wrong item.
 */
test("an extension user is not told to back up a key Buzz does not hold", () => {
  const items = buildChecklist(facts({ usesLocalKey: false }));
  assert.equal(items.length, 4);
  assert.equal(
    items.some((item) => item.id === "backup"),
    false,
  );
});

test("the key backup is the only critical item", () => {
  const critical = buildChecklist(facts()).filter((item) => item.critical);
  assert.equal(critical.length, 1);
  assert.equal(critical[0].id, "backup");
});

test("each fact ticks exactly its own item", () => {
  const items = buildChecklist(
    facts({ hasDisplayName: true, themeChosen: true }),
  );
  const byId = new Map(items.map((item) => [item.id, item.done]));
  assert.equal(byId.get("profile"), true);
  assert.equal(byId.get("theme"), true);
  assert.equal(byId.get("backup"), false);
  assert.equal(byId.get("channel"), false);
  assert.equal(byId.get("notifications"), false);
});

test("progress counts done against total", () => {
  const progress = checklistProgress(
    buildChecklist(facts({ hasDisplayName: true })),
  );
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 5);
  assert.equal(progress.complete, false);
  assert.equal(progress.hasOutstandingCritical, true);
});

test("everything done is complete with no outstanding critical", () => {
  const progress = checklistProgress(
    buildChecklist(
      facts({
        hasDisplayName: true,
        hasKeyBackup: true,
        notificationsDecided: true,
        themeChosen: true,
        inAChannel: true,
      }),
    ),
  );
  assert.equal(progress.complete, true);
  assert.equal(progress.done, 5);
  assert.equal(progress.hasOutstandingCritical, false);
});

// ── visibility ──────────────────────────────────────────────────────────────

test("a complete checklist never shows, dismissed or not", () => {
  const progress = {
    done: 5,
    total: 5,
    complete: true,
    hasOutstandingCritical: false,
  };
  assert.equal(shouldShowChecklist({ dismissed: false, progress }), false);
  assert.equal(shouldShowChecklist({ dismissed: true, progress }), false);
});

/**
 * The rule that matters. Both cases below are dismissed and incomplete; only
 * the outstanding CRITICAL item differs, so an implementation that simply
 * honoured `dismissed` would return false for both and fail here.
 */
test("a dismissal is overridden while the key is unbacked", () => {
  assert.equal(
    shouldShowChecklist({
      dismissed: true,
      progress: {
        done: 1,
        total: 5,
        complete: false,
        hasOutstandingCritical: true,
      },
    }),
    true,
  );
  assert.equal(
    shouldShowChecklist({
      dismissed: true,
      progress: {
        done: 4,
        total: 5,
        complete: false,
        hasOutstandingCritical: false,
      },
    }),
    false,
  );
});

test("an undismissed incomplete checklist shows", () => {
  assert.equal(
    shouldShowChecklist({
      dismissed: false,
      progress: {
        done: 4,
        total: 5,
        complete: false,
        hasOutstandingCritical: false,
      },
    }),
    true,
  );
});

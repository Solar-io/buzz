/**
 * Encrypted key backup — the web counterpart of the desktop's
 * `PrivateKeyBackupRow` + `EncryptedBackupCreator` + `BackupTestFlow`.
 *
 * The three steps are deliberately in one card rather than a wizard, because
 * the middle one is the one people skip: creating a backup is satisfying,
 * verifying it is not, and an unverified backup is a promise nobody has
 * checked. Here the verify step sits directly under the download button with
 * the passphrase field already in front of you.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Download, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { nsecEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { getUnlockedSecretKey } from "@/shared/lib/key-store";

import { useSignerSource } from "../useSignerSource";

import {
  backupFileBody,
  backupFileName,
  backupPassphraseIssue,
  backupPassphraseReady,
} from "../lib/backupFile.ts";
import {
  encryptSecretKeyToNcryptsec,
  readBackupRecord,
  recordBackup,
  verifyBackupRestores,
  type BackupRecord,
} from "../keyBackup";

function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Reveal the raw nsec behind a deliberate click — the desktop's masked row. */
function RevealKey() {
  const [shown, setShown] = useState(false);
  const secretKey = getUnlockedSecretKey();
  if (!secretKey) return null;
  return (
    <div className="space-y-1">
      <Button
        onClick={() => setShown((value) => !value)}
        size="sm"
        variant="ghost"
      >
        {shown ? (
          <EyeOff className="mr-1 h-3.5 w-3.5" />
        ) : (
          <Eye className="mr-1 h-3.5 w-3.5" />
        )}
        {shown ? "Hide my key" : "Reveal my key"}
      </Button>
      {shown ? (
        <p
          className="select-all break-all rounded-md bg-muted p-2 font-mono text-xs"
          data-testid="revealed-nsec"
        >
          {nsecEncode(secretKey)}
        </p>
      ) : null}
    </div>
  );
}

export function KeyBackupCard() {
  const source = useSignerSource();
  const [passphrase, setPassphrase] = useState("");
  const [ncryptsec, setNcryptsec] = useState<string | null>(null);
  const [record, setRecord] = useState<BackupRecord | null>(null);
  const [verifyPassphrase, setVerifyPassphrase] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readBackupRecord().then(setRecord);
  }, []);

  const issue = backupPassphraseIssue(passphrase);
  const ready = backupPassphraseReady(passphrase);

  const createAndDownload = useCallback(() => {
    const secretKey = getUnlockedSecretKey();
    if (!secretKey) {
      toast.error("Unlock your key first.");
      return;
    }
    setBusy(true);
    // Key derivation is deliberately slow; yield a frame so the button can
    // paint its busy state before the main thread blocks.
    window.setTimeout(() => {
      try {
        const blob = encryptSecretKeyToNcryptsec(secretKey, passphrase);
        const now = new Date();
        downloadText(backupFileName(now), backupFileBody(blob, now));
        setNcryptsec(blob);
        setVerified(false);
        setVerifyPassphrase("");
        const pubkey = getPublicKey(secretKey);
        void recordBackup(pubkey).then(() =>
          readBackupRecord().then(setRecord),
        );
        toast.success("Backup downloaded. Now check that it opens.");
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not create the backup.",
        );
      } finally {
        setBusy(false);
      }
    }, 0);
  }, [passphrase]);

  const runVerify = useCallback(() => {
    const secretKey = getUnlockedSecretKey();
    if (!ncryptsec || !secretKey) return;
    setBusy(true);
    window.setTimeout(() => {
      const result = verifyBackupRestores(
        ncryptsec,
        verifyPassphrase,
        getPublicKey(secretKey),
      );
      setBusy(false);
      if (result.ok) {
        setVerified(true);
        toast.success("The backup opens and matches this identity.");
      } else {
        setVerified(false);
        toast.error(result.reason);
      }
    }, 0);
  }, [ncryptsec, verifyPassphrase]);

  if (source !== "local") {
    return (
      <section
        className="space-y-2 rounded-lg border border-border bg-card p-4"
        data-testid="key-backup-card"
      >
        <h2 className="font-medium">Key backup</h2>
        <p className="text-sm text-muted-foreground">
          You are signing with a browser extension, which holds the key itself.
          Back it up wherever that extension tells you to — Buzz never sees it.
        </p>
      </section>
    );
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="key-backup-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Key backup</h2>
        {record ? (
          <span className="text-xs text-muted-foreground">
            Last backup {new Date(record.createdAt).toLocaleDateString()}
          </span>
        ) : (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            No backup on this device
          </span>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Your key exists only in this browser's storage. Clearing site data or
        losing this profile loses the identity. A NIP-49 backup is an encrypted
        file you can restore here or in Buzz Desktop — it is useless without the
        passphrase, so choose one you will not lose either.
      </p>

      <div className="space-y-1.5">
        <label className="block text-sm font-medium" htmlFor="backup-pass">
          Backup passphrase
        </label>
        <div className="flex gap-2">
          <Input
            autoComplete="new-password"
            id="backup-pass"
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="at least 12 characters"
            type="password"
            value={passphrase}
          />
          <Button
            disabled={!ready || busy}
            onClick={createAndDownload}
            size="sm"
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            {busy ? "Working…" : "Create + download"}
          </Button>
        </div>
        {issue ? (
          <p className="text-xs text-destructive" role="alert">
            {issue}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            This is not your sign-in passphrase. It only opens the file.
          </p>
        )}
      </div>

      {ncryptsec ? (
        <div className="space-y-1.5 rounded-md border border-border p-3">
          <p className="text-sm font-medium">
            {verified ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" /> Backup verified
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-4 w-4" /> Check it actually opens
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Type the passphrase again. Buzz decrypts the file it just made and
            confirms it restores this same identity — an untested backup is a
            guess.
          </p>
          <div className="flex gap-2">
            <Input
              autoComplete="off"
              onChange={(event) => setVerifyPassphrase(event.target.value)}
              placeholder="passphrase"
              type="password"
              value={verifyPassphrase}
            />
            <Button
              disabled={busy || verifyPassphrase.length === 0}
              onClick={runVerify}
              size="sm"
              variant="outline"
            >
              Verify
            </Button>
          </div>
        </div>
      ) : null}

      <RevealKey />
    </section>
  );
}

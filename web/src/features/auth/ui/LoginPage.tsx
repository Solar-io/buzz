import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useAuth } from "./AuthProvider";
import { QrScanner } from "./QrScanner";
import { enrollSecretKey, setAuthTagJson } from "@/shared/lib/key-store";
import { type ParsedKey, parseSecretKeyInput } from "@/shared/lib/nsec";

type Mode = "choose" | "paste" | "scan" | "set-pass" | "unlock";

export function LoginPage() {
  const { canSign, isLocked, extensionAvailable, unlock } = useAuth();
  const navigate = useNavigate();
  // Derived until the user picks: initKeyStore resolves async after first
  // render, so a locked device must upgrade "choose" → "unlock" on its own.
  const [modeOverride, setModeOverride] = useState<Mode | null>(null);
  const mode: Mode = modeOverride ?? (isLocked ? "unlock" : "choose");
  const setMode = setModeOverride;
  const [keyInput, setKeyInput] = useState("");
  const [scanned, setScanned] = useState<ParsedKey | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);

  if (canSign) {
    void navigate({ to: "/repos" });
  }

  const finishEnroll = useCallback(
    async (parsed: ParsedKey, pass: string) => {
      if (!parsed.ok) {
        toast.error(parsed.error);
        return;
      }
      setBusy(true);
      setAuthTagJson(tagInput.trim() || null);
      try {
        await enrollSecretKey(parsed.secretKey, pass);
        toast.success("Signed in");
        // authState flips and the shell route re-renders on its own; the
        // URL (and any ?c= deep link) stays untouched.
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not store the key",
        );
        setBusy(false);
      }
    },
    [tagInput],
  );

  const acceptScanned = useCallback((text: string) => {
    const parsed = parseSecretKeyInput(text);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setScanned(parsed);
    setMode("set-pass");
  }, []);

  // Pairing-link landing: a camera-scanned QR opens this page with the key in
  // the URL fragment (fragments never reach a server). Consume it once into
  // the normal set-pass flow, then scrub the address bar so the key does not
  // linger in history or get copy-pasted around accidentally.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.toLowerCase().includes("nsec=")) {
      return;
    }
    const parsed = parseSecretKeyInput(
      `${window.location.origin}${window.location.pathname}${hash}`,
    );
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    if (parsed.ok) {
      setScanned(parsed);
      setMode("set-pass");
    } else {
      toast.error(parsed.error);
    }
  }, []);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-center text-2xl font-semibold tracking-tight">
          Buzz
        </h1>

        {mode === "unlock" && (
          <form
            className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              unlock(passphrase)
                .then(() => {
                  toast.success("Unlocked");
                })
                .catch(() => {
                  toast.error("Wrong passphrase");
                  setBusy(false);
                });
            }}
          >
            <p className="text-sm text-muted-foreground">
              Enter this device's passphrase to unlock your key.
            </p>
            <Input
              type="password"
              placeholder="Passphrase"
              autoComplete="current-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoFocus
            />
            <Button className="w-full" disabled={busy || !passphrase}>
              Unlock
            </Button>
          </form>
        )}

        {mode === "choose" && (
          <div className="space-y-3">
            {extensionAvailable && (
              <Button
                className="w-full"
                onClick={() => void navigate({ to: "/repos" })}
              >
                Continue with browser extension
              </Button>
            )}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setMode("paste")}
            >
              Enter key manually
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setMode("scan")}
            >
              Pair with QR code
            </Button>
          </div>
        )}

        {mode === "paste" && (
          <form
            className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = parseSecretKeyInput(keyInput);
              if (!parsed.ok) {
                toast.error(parsed.error);
                return;
              }
              setScanned(parsed);
              setMode("set-pass");
            }}
          >
            <p className="text-sm text-muted-foreground">
              Paste your key (nsec1…). It is encrypted on this device and never
              sent anywhere.
            </p>
            <Input
              type="password"
              placeholder="nsec1…"
              autoComplete="off"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMode("choose")}
              >
                Back
              </Button>
              <Button className="flex-1" disabled={!keyInput.trim()}>
                Continue
              </Button>
            </div>
          </form>
        )}

        {mode === "scan" && (
          <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
            <p className="text-sm text-muted-foreground">
              On an unlocked device: Settings → Pair a device, then point this
              camera at the QR.
            </p>
            <QrScanner
              onResult={acceptScanned}
              onError={(m) => toast.error(m)}
            />
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setMode("choose")}
            >
              Back
            </Button>
          </div>
        )}

        {mode === "set-pass" && scanned?.ok && (
          <form
            className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              if (passphrase.length < 8) {
                toast.error("Use at least 8 characters.");
                return;
              }
              if (passphrase !== confirm) {
                toast.error("Passphrases do not match.");
                return;
              }
              void finishEnroll(scanned, passphrase);
            }}
          >
            <p className="text-sm text-muted-foreground">
              Key accepted. Choose a passphrase to encrypt it on this device —
              you'll enter it to unlock.
            </p>
            <Input
              type="password"
              placeholder="New passphrase"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoFocus
            />
            <Input
              type="password"
              placeholder="Confirm passphrase"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer select-none">
                Agent attestation (agents only)
              </summary>
              <textarea
                className="mt-2 w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs"
                rows={3}
                placeholder='["auth","…"] — from the agent environment'
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
              />
              <p className="mt-1 text-xs">
                Relay membership for agent keys is attested by the owner. Humans
                leave this empty.
              </p>
            </details>
            <Button
              className="w-full"
              disabled={busy || !passphrase || !confirm}
            >
              {busy ? "Saving…" : "Finish"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

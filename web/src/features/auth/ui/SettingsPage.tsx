import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import QRCode from "qrcode";
import { getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  getConfiguredFilesUrl,
  setConfiguredFilesUrl,
} from "@/features/files/filesConfig";
import { NotificationSettingsDialog } from "@/features/notifications/ui/NotificationSettingsDialog";
import { AppearanceSection } from "./AppearanceSection";
import { useAuth } from "./AuthProvider";
import { activeSignerSource } from "@/shared/lib/nostr-signer";
import {
  clearRememberedKey,
  getUnlockedSecretKey,
  hasNoPassphrase,
  hasRememberedKey,
  rememberSecretKeyForSettings,
} from "@/shared/lib/key-store";
import { pairingLink } from "@/shared/lib/nsec";
import { relayWsUrl } from "@/shared/lib/relay-url";

export function SettingsPage() {
  const { lock, forgetDevice } = useAuth();
  const source = activeSignerSource();
  const [npub, setNpub] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [staySignedIn, setStaySignedIn] = useState<boolean | null>(null);
  const [noPassphrase, setNoPassphrase] = useState(false);

  useEffect(() => {
    void hasRememberedKey().then(setStaySignedIn);
    void hasNoPassphrase().then(setNoPassphrase);
  }, []);

  const toggleStaySignedIn = useCallback(() => {
    const next = !staySignedIn;
    if (next) {
      setStaySignedIn(true);
      const secretKey = getUnlockedSecretKey();
      if (secretKey) {
        void rememberSecretKeyForSettings(secretKey).catch(() => {
          toast.error("Could not store the remembered key.");
          setStaySignedIn(false);
        });
      } else {
        toast.error("Unlock first, then enable stay-signed-in.");
        setStaySignedIn(false);
      }
      return;
    }
    // Turning stay-signed-in off on a QR-paired device: there is no user
    // passphrase to fall back on, so removing the remembered key would
    // leave the envelope permanently locked. Sign out instead (re-pair to
    // return) — confirm because it signs out of this browser.
    if (noPassphrase) {
      const signOutNow = window.confirm(
        "This device was paired without a passphrase. Turning stay-signed-in off signs it out completely — re-scan a pairing QR to use Buzz here again.",
      );
      if (!signOutNow) {
        return;
      }
      void forgetDevice();
      return;
    }
    setStaySignedIn(false);
    void clearRememberedKey().catch(() => {
      toast.error("Could not remove the remembered key.");
      setStaySignedIn(true);
    });
  }, [staySignedIn, noPassphrase, forgetDevice]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (source === "local") {
          const secretKey = getUnlockedSecretKey();
          if (secretKey) {
            setNpub(npubEncode(getPublicKey(secretKey)));
          }
          return;
        }
        if (source === "extension" && window.nostr) {
          const hex = await window.nostr.getPublicKey();
          if (!cancelled) {
            setNpub(hex.startsWith("npub") ? hex : npubEncode(hex));
          }
        }
      } catch {
        // Pubkey display is best-effort; settings still works without it.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const showQr = useCallback(async () => {
    const secretKey = getUnlockedSecretKey();
    if (!secretKey) {
      toast.error("Unlock a local key first.");
      return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(
        pairingLink(window.location.origin, secretKey),
        {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 320,
        },
      );
      setQrDataUrl(dataUrl);
    } catch {
      toast.error("Could not render the QR code.");
    }
  }, []);

  return (
    <div className="mx-auto max-w-lg space-y-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/repos">Back to channels</Link>
        </Button>
      </div>

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Agents</h2>
          <Button asChild variant="ghost" size="sm">
            <Link to="/repos/agents">Manage agents</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Create agents and change their settings — drafts are reviewed in Buzz
          Desktop.
        </p>
      </section>

      <NotificationsSection />

      <AppearanceSection />

      <FilesUrlSection />

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">This device</h2>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Signing with</dt>
            <dd>
              {source === "local"
                ? "Key stored on this device"
                : source === "extension"
                  ? "Browser extension (NIP-07)"
                  : "Ephemeral identity"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Relay</dt>
            <dd className="truncate font-mono text-xs">{relayWsUrl()}</dd>
          </div>
          {source === "local" && staySignedIn !== null && (
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">Stay signed in</dt>
              <dd className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  keeps refreshes unlocked
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleStaySignedIn}
                >
                  {staySignedIn ? "On" : "Off"}
                </Button>
              </dd>
            </div>
          )}
          {npub && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">You</dt>
              <dd className="truncate font-mono text-xs" title={npub}>
                {npub}
              </dd>
            </div>
          )}
        </dl>
        {source === "local" && (
          <Button variant="outline" size="sm" onClick={() => lock()}>
            Lock now
          </Button>
        )}
      </section>

      {source === "local" && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium">Pair a device</h2>
          <p className="text-sm text-muted-foreground">
            Show a QR that opens Buzz with your key — scan it with any camera
            and that device signs straight in, nothing to type. The key rides
            inside the link itself, only on your screens — treat it like a
            password.
          </p>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Device pairing QR code"
              className="mx-auto rounded-md border border-border"
              width={320}
              height={320}
            />
          ) : (
            <Button size="sm" onClick={() => void showQr()}>
              Show pairing QR
            </Button>
          )}
        </section>
      )}

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">Forget this device</h2>
        <p className="text-sm text-muted-foreground">
          Removes the stored key from this browser. Other devices are
          unaffected.
        </p>
        <ConfirmForget onConfirm={() => void forgetDevice()} />
      </section>
    </div>
  );
}

/**
 * File-manager URL — the one External-tier setting. Shows the effective URL
 * (browser override, else the build default), lets the user change or clear
 * it. Changing it here is the supported path once a URL is already set.
 */
/**
 * Notifications entry point.
 *
 * The dialog owns the permission prompt, because the browser only grants
 * permission from a real user gesture — so it has to be raised from the
 * control the user actually clicked, not on mount.
 */
function NotificationsSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">Notifications</h2>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Manage
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Choose what alerts you when Buzz is in a background tab.
      </p>
      <NotificationSettingsDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}

function FilesUrlSection() {
  const [url, setUrl] = useState(() => getConfiguredFilesUrl());
  const [entry, setEntry] = useState("");
  const effective = url || "(not configured — Files will ask)";
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">Files</h2>
      <p className="text-sm text-muted-foreground">
        The web file manager embedded by the Files panel. Current:{" "}
        <span className="break-all font-mono text-xs">{effective}</span>
      </p>
      <div className="flex gap-2">
        <Input
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          placeholder="https://files.your-network/"
          aria-label="File manager URL"
        />
        <Button
          size="sm"
          disabled={!entry.trim()}
          onClick={() => {
            setConfiguredFilesUrl(entry.trim());
            setUrl(entry.trim());
            setEntry("");
          }}
        >
          Save
        </Button>
        {url ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfiguredFilesUrl(null);
              setUrl("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground/70">
        Saved on this browser; a build-time default may apply when cleared.
      </p>
    </section>
  );
}

function ConfirmForget({ onConfirm }: { onConfirm: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder='Type "forget" to confirm'
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="max-w-48"
      />
      <Button
        variant="destructive"
        size="sm"
        disabled={text.trim().toLowerCase() !== "forget"}
        onClick={onConfirm}
      >
        Forget
      </Button>
    </div>
  );
}

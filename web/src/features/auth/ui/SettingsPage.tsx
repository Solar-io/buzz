import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import QRCode from "qrcode";
import { getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useAuth } from "./AuthProvider";
import { activeSignerSource } from "@/shared/lib/nostr-signer";
import { getUnlockedSecretKey } from "@/shared/lib/key-store";
import { nsecFromSecretKey } from "@/shared/lib/nsec";
import { relayWsUrl } from "@/shared/lib/relay-url";

export function SettingsPage() {
  const { lock, forgetDevice } = useAuth();
  const source = activeSignerSource();
  const [npub, setNpub] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

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
      const dataUrl = await QRCode.toDataURL(nsecFromSecretKey(secretKey), {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      });
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
          <Link to="/">Back</Link>
        </Button>
      </div>

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
            Show a QR containing your key. On the other device's login screen,
            choose "Pair with QR code" and scan. The key is only on your screens
            — treat it like a password.
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

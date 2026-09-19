import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { prepareNativeCommunityChange } from "@/shared/lib/key-store";
import {
  readNativeServices,
  writeNativeServices,
  validateServices,
} from "./config";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QrScanner } from "@/features/auth/ui/QrScanner";
import {
  parsePairingServices,
  describeConnectionChanges,
} from "@/shared/lib/pairing-link";
import { applyScannedConnection } from "@/shared/lib/apply-scanned-connection";

export function NativeDeviceSettings() {
  const { lock } = useAuth();
  const [services, setServices] = useState(readNativeServices());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="font-medium">Identity and connection</h2>
      <p className="text-sm text-muted-foreground">
        Your signing key stays in iOS Keychain. Keep your original pairing
        device or encrypted backup to enroll another device.
      </p>
      <button
        className="rounded border border-border px-3 py-2 text-sm"
        onClick={lock}
        type="button"
      >
        Lock Buzz
      </button>

      {/* Resolved connection addresses */}
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Relay</dt>
          <dd className="truncate font-mono text-xs" title={services?.relayUrl}>
            {(() => {
              try {
                return new URL(relayWsUrl()).host;
              } catch {
                return "No relay configured.";
              }
            })()}
          </dd>
        </div>
        {services?.sttUrl && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Speech recognition</dt>
            <dd className="truncate font-mono text-xs" title={services.sttUrl}>
              {(() => {
                try {
                  return new URL(services.sttUrl).host;
                } catch {
                  return "(invalid URL)";
                }
              })()}
            </dd>
          </div>
        )}
        {services?.ttsUrl && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Agent speech</dt>
            <dd className="truncate font-mono text-xs" title={services.ttsUrl}>
              {(() => {
                try {
                  return new URL(services.ttsUrl).host;
                } catch {
                  return "(invalid URL)";
                }
              })()}
            </dd>
          </div>
        )}
      </dl>

      {/* QR scanner for updating connection */}
      {scanning ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            Scan a pairing QR to update your connection.
          </p>
          <QrScanner
            onResult={(text) => {
              try {
                const scanned = parsePairingServices(text);
                void applyScannedConnection(services, scanned, {
                  confirm: async (current, merged) => {
                    const changes = describeConnectionChanges(current, merged);
                    if (changes.length === 0) {
                      return window.confirm("Update connection?");
                    }
                    const relayChanging = current.relayUrl !== merged.relayUrl;
                    const message = `Update connection?\n\n${changes.join("\n")}${relayChanging ? "\n\nThis leaves any active call and disables push." : ""}`;
                    return window.confirm(message);
                  },
                  prepare: async () => {
                    await prepareNativeCommunityChange();
                  },
                  write: async (newServices) => {
                    writeNativeServices(newServices);
                    setServices(newServices);
                  },
                  validate: validateServices,
                })
                  .then((result) => {
                    if (result === "applied") {
                      setScanning(false);
                      toast.success("Connection updated from QR");
                    }
                  })
                  .catch((error) => {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Could not apply QR connection",
                    );
                  });
              } catch (error) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : "Could not parse QR code",
                );
              }
            }}
            onError={(m) => toast.error(m)}
          />
          <button
            type="button"
            className="w-full rounded border border-border p-2 text-sm"
            onClick={() => setScanning(false)}
          >
            Back
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="rounded border border-border px-3 py-2 text-sm"
          onClick={() => setScanning(true)}
        >
          Scan to update connection
        </button>
      )}

      <details>
        <summary className="cursor-pointer text-sm">
          Connection settings
        </summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!services) return;
            setBusy(true);
            setError("");
            void prepareNativeCommunityChange()
              .then(() => {
                writeNativeServices(services);
                window.location.replace("/repos");
              })
              .catch((reason: unknown) => {
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Could not change connection.",
                );
                setBusy(false);
              });
          }}
        >
          {services &&
            (
              [
                ["relayUrl", "Relay"],
                ["sttUrl", "Speech recognition"],
                ["ttsUrl", "Agent speech"],
                ["pushGatewayUrl", "Push gateway"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block text-sm">
                {label}
                <input
                  className="mt-1 w-full rounded border border-input bg-background p-2 text-base"
                  value={services[key]}
                  onChange={(event) =>
                    setServices({
                      ...services,
                      [key]: event.target.value.trim(),
                    })
                  }
                  autoCorrect="off"
                  autoCapitalize="none"
                  required={key === "relayUrl"}
                />
              </label>
            ))}
          <p className="text-xs text-muted-foreground">
            Saving leaves the active call and disables the current push
            registration. Enable notifications again after connecting.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            disabled={busy}
            type="submit"
            className="rounded bg-primary px-3 py-2 text-primary-foreground"
          >
            {busy ? "Saving…" : "Save connection"}
          </button>
        </form>
      </details>
    </section>
  );
}

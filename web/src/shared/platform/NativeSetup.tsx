import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  BuzzHuddle,
  BuzzIdentity,
  isNativeIOS,
  type LegacyIdentityRestore,
} from "./native";
import {
  readNativeServices,
  writeNativeServices,
  validateServices,
  type NativeServices,
} from "./config";
import { QrScanner } from "@/features/auth/ui/QrScanner";
import {
  parsePairingServices,
  classifyScannedConnection,
} from "@/shared/lib/pairing-link";
import { applyScannedConnection } from "@/shared/lib/apply-scanned-connection";
import { prepareNativeCommunityChange } from "@/shared/lib/key-store";

export function NativeSetup({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<NativeServices>(
    () =>
      readNativeServices() ?? {
        relayUrl: import.meta.env.VITE_RELAY_URL ?? "",
        sttUrl: import.meta.env.VITE_STT_URL ?? "",
        ttsUrl: import.meta.env.VITE_TTS_URL ?? "",
        pushGatewayUrl: import.meta.env.VITE_PUSH_GATEWAY_URL ?? "",
      },
  );
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [previous, setPrevious] = useState<LegacyIdentityRestore["choices"]>(
    [],
  );
  const [restoring, setRestoring] = useState(false);
  const restore = async (selectedId?: string) => {
    setRestoring(true);
    try {
      const restored = await BuzzIdentity.restoreFlutter({ selectedId });
      if (restored.relayUrl) {
        const sameCommunity =
          services.relayUrl &&
          new URL(services.relayUrl).host === new URL(restored.relayUrl).host;
        const next = {
          ...services,
          relayUrl: restored.relayUrl,
          ...(sameCommunity
            ? {}
            : { sttUrl: "", ttsUrl: "", pushGatewayUrl: "" }),
        };
        writeNativeServices(next);
        setServices(next);
      } else {
        setPrevious(restored.choices ?? []);
      }
    } catch {
      setError(
        "The previous Buzz login could not be restored. You can continue and pair or sign in.",
      );
    } finally {
      setRestoring(false);
    }
  };
  // Only first setup attempts migration; changing input fields is not a retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial native migration only
  useEffect(() => {
    if (isNativeIOS() && !readNativeServices()) void restore();
  }, []);
  if (!isNativeIOS() || readNativeServices()) return children;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <form
        className="w-full max-w-md space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void BuzzHuddle.leave()
            .then(() => {
              writeNativeServices(services);
              window.location.replace("/repos");
            })
            .catch((reason: unknown) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not save connection.",
              ),
            );
        }}
      >
        <h1 className="text-xl font-semibold">Connect Buzz</h1>
        {previous && previous.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm">
              Choose the previous Buzz community to restore.
            </p>
            {previous.map((community) => (
              <button
                type="button"
                key={community.id}
                disabled={restoring}
                className="block w-full rounded border border-border p-3 text-left"
                onClick={() => void restore(community.id)}
              >
                {community.name}
                <span className="block truncate text-xs text-muted-foreground">
                  {community.relayUrl}
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          {services.relayUrl
            ? "Your community connection is ready. Continue to pair this iPhone or sign in."
            : "Enter your community connection to get started."}
        </p>
        {scanning && (
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              Point your camera at a pairing QR code from an already-connected
              device.
            </p>
            <QrScanner
              onResult={(text) => {
                try {
                  const scanned = parsePairingServices(text);
                  const current = readNativeServices();

                  void applyScannedConnection(current, scanned, {
                    classify: classifyScannedConnection,
                    confirm: async (current, scanned) => {
                      const changes: string[] = [];
                      if (new URL(current.relayUrl).host !== new URL(scanned.relayUrl).host) {
                        changes.push(
                          `relay: ${new URL(current.relayUrl).host} → ${new URL(scanned.relayUrl).host}`,
                        );
                      }
                      if (current.sttUrl !== scanned.sttUrl) {
                        changes.push("speech recognition");
                      }
                      if (current.ttsUrl !== scanned.ttsUrl) {
                        changes.push("agent speech");
                      }
                      if (current.pushGatewayUrl !== scanned.pushGatewayUrl) {
                        changes.push("push gateway");
                      }
                      const message = changes.length > 0
                        ? `Update connection?\n\n${changes.join("\n")}${current.relayUrl !== scanned.relayUrl ? "\n\nThis leaves any active call and disables push." : ""}`
                        : "No changes detected in this QR code.";
                      return window.confirm(message);
                    },
                    prepare: async () => {
                      await prepareNativeCommunityChange();
                    },
                    write: async (services) => {
                      writeNativeServices(services);
                      setServices(services);
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
                } catch {
                  toast.error("Could not parse QR code");
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
        )}
        {!scanning && (
          <>
            <button
              type="button"
              className="w-full rounded border border-border p-3 text-sm"
              onClick={() => setScanning(true)}
            >
              Pair with QR code
            </button>
            <details open={!services.relayUrl}>
              <summary className="cursor-pointer text-sm">
                Advanced connection settings
              </summary>
              {(
                [
                  ["relayUrl", "Relay", "wss://relay.your-network/"],
                  [
                    "sttUrl",
                    "Speech recognition",
                    "wss://speech.your-network/stt",
                  ],
                  ["ttsUrl", "Agent speech", "https://speech.your-network/tts"],
                  [
                    "pushGatewayUrl",
                    "Push gateway",
                    "https://push.your-network/",
                  ],
                ] as const
              ).map(([key, label, placeholder]) => (
                <label className="block space-y-1" key={key}>
                  <span className="text-sm">{label}</span>
                  <input
                    className="w-full rounded border border-input bg-background p-3 text-base"
                    aria-label={label}
                    placeholder={placeholder}
                    value={services[key]}
                    required={key === "relayUrl"}
                    autoCapitalize="none"
                    autoCorrect="off"
                    onChange={(event) =>
                      setServices({
                        ...services,
                        [key]: event.target.value.trim(),
                      })
                    }
                  />
                </label>
              ))}
            </details>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <button
          className="w-full rounded bg-primary p-3 text-primary-foreground"
          type="submit"
          disabled={restoring}
        >
          Connect
        </button>
      </form>
    </main>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import {
  BuzzHuddle,
  BuzzIdentity,
  isNativeIOS,
  type LegacyIdentityRestore,
} from "./native";
import {
  readNativeServices,
  writeNativeServices,
  type NativeServices,
} from "./config";

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
  const [previous, setPrevious] = useState<LegacyIdentityRestore["choices"]>(
    [],
  );
  const [restoring, setRestoring] = useState(false);
  const restore = async (selectedId?: string) => {
    setRestoring(true);
    try {
      const restored = await BuzzIdentity.restoreFlutter({ selectedId });
      if (restored.relayUrl) {
        const next = { ...services, relayUrl: restored.relayUrl };
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
  useEffect(() => {
    if (isNativeIOS() && !readNativeServices()) void restore();
    // Only first setup attempts migration; changing input fields is not a retry.
    // biome-ignore lint/correctness/useExhaustiveDependencies: initial native migration only
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
        <details open={!services.relayUrl}>
          <summary className="cursor-pointer text-sm">
            Advanced connection settings
          </summary>
          {(
            [
              ["relayUrl", "Relay", "wss://relay.your-network/"],
              ["sttUrl", "Speech recognition", "wss://speech.your-network/stt"],
              ["ttsUrl", "Agent speech", "https://speech.your-network/tts"],
              ["pushGatewayUrl", "Push gateway", "https://push.your-network/"],
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
                  setServices({ ...services, [key]: event.target.value.trim() })
                }
              />
            </label>
          ))}
        </details>
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

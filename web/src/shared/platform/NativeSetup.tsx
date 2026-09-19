import { useState, type ReactNode } from "react";
import { BuzzHuddle, isNativeIOS } from "./native";
import { readNativeServices, writeNativeServices, type NativeServices } from "./config";

export function NativeSetup({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<NativeServices>(() => readNativeServices() ?? {
    relayUrl: import.meta.env.VITE_RELAY_URL ?? "",
    sttUrl: import.meta.env.VITE_STT_URL ?? "",
    ttsUrl: import.meta.env.VITE_TTS_URL ?? "",
    pushGatewayUrl: import.meta.env.VITE_PUSH_GATEWAY_URL ?? "",
  });
  const [error, setError] = useState("");
  if (!isNativeIOS() || readNativeServices()) return children;
  return <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
    <form className="w-full max-w-md space-y-4" onSubmit={(event) => {
      event.preventDefault();
      void BuzzHuddle.leave().then(() => {
        writeNativeServices(services); window.location.replace("/repos");
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not save connection."));
    }}>
      <h1 className="text-xl font-semibold">Connect Buzz</h1>
      <p className="text-sm text-muted-foreground">Enter your community relay. Speech and push service addresses are optional; your community operator provides them.</p>
      {([
        ["relayUrl", "Relay", "wss://relay.your-network/"],
        ["sttUrl", "Speech recognition", "wss://speech.your-network/stt"],
        ["ttsUrl", "Agent speech", "https://speech.your-network/tts"],
        ["pushGatewayUrl", "Push gateway", "https://push.your-network/"],
      ] as const).map(([key, label, placeholder]) => <label className="block space-y-1" key={key}>
        <span className="text-sm">{label}</span>
        <input className="w-full rounded border border-input bg-background p-3 text-base" aria-label={label} placeholder={placeholder} value={services[key]} required={key === "relayUrl"} autoCapitalize="none" autoCorrect="off" onChange={(event) => setServices({ ...services, [key]: event.target.value.trim() })} />
      </label>)}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button className="w-full rounded bg-primary p-3 text-primary-foreground" type="submit">Connect</button>
    </form>
  </main>;
}

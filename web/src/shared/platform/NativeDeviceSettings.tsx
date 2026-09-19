import { useState } from "react";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { prepareNativeCommunityChange } from "@/shared/lib/key-store";
import { readNativeServices, writeNativeServices } from "./config";

export function NativeDeviceSettings() {
  const { lock } = useAuth();
  const [services, setServices] = useState(readNativeServices());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="space-y-3 rounded-lg border border-border p-4">
    <h2 className="font-medium">Identity and connection</h2>
    <p className="text-sm text-muted-foreground">Your signing key stays in iOS Keychain. Keep your original pairing device or encrypted backup to enroll another device.</p>
    <button className="rounded border border-border px-3 py-2 text-sm" onClick={lock} type="button">Lock Buzz</button>
    <details><summary className="cursor-pointer text-sm">Connection settings</summary>
      <form className="mt-3 space-y-3" onSubmit={(event) => {
        event.preventDefault(); if (!services) return; setBusy(true); setError("");
        void prepareNativeCommunityChange().then(() => { writeNativeServices(services); window.location.replace("/repos"); }).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : "Could not change connection."); setBusy(false); });
      }}>
        {services && ([["relayUrl", "Relay"], ["sttUrl", "Speech recognition"], ["ttsUrl", "Agent speech"], ["pushGatewayUrl", "Push gateway"]] as const).map(([key, label]) => <label key={key} className="block text-sm">{label}<input className="mt-1 w-full rounded border border-input bg-background p-2 text-base" value={services[key]} onChange={(event) => setServices({ ...services, [key]: event.target.value.trim() })} autoCorrect="off" autoCapitalize="none" required={key === "relayUrl"} /></label>)}
        <p className="text-xs text-muted-foreground">Saving leaves the active call and disables the current push registration. Enable notifications again after connecting.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button disabled={busy} type="submit" className="rounded bg-primary px-3 py-2 text-primary-foreground">{busy ? "Saving…" : "Save connection"}</button>
      </form>
    </details>
  </section>;
}

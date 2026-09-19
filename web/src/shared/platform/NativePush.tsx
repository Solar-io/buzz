import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { nip44EncryptTo, signNostrEvent } from "@/shared/lib/nostr-signer";
import { setNativeBeforeForget } from "@/shared/lib/key-store";
import { nip98Headers } from "@/shared/lib/nip98";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { router } from "@/app/router";
import { readNativeServices } from "./config";
import { BuzzPush, isNativeIOS } from "./native";
import { createPushEnrollment, type PushEnrollmentStatus } from "./push-enrollment";

function useNativePushService() {
  const pubkey = useOwnPubkey();
  const { session } = useRelaySession();
  const [profile, setProfile] = useState<"buzz-capacitor-ios-sandbox" | "buzz-capacitor-ios-production" | null>(null);
  useEffect(() => {
    if (!isNativeIOS()) return;
    void BuzzPush.isSupported().then((result) => {
      if (result.appProfile === "buzz-capacitor-ios-sandbox" || result.appProfile === "buzz-capacitor-ios-production") setProfile(result.appProfile);
    }).catch(() => {});
  }, []);
  return useMemo(() => {
    const gatewayUrl = readNativeServices()?.pushGatewayUrl;
    if (!isNativeIOS() || !pubkey || !profile || !gatewayUrl) return null;
    return createPushEnrollment({ relayUrl: relayWsUrl(), gatewayUrl, profile, pubkey, plugin: BuzzPush,
      encrypt: (peer, plaintext) => nip44EncryptTo(plaintext, peer),
      publish: async (event) => session.publish(await signNostrEvent(event)),
    });
  }, [pubkey, session, profile]);
}

export function NativePushRuntime() {
  const { canSign } = useAuth();
  const service = useNativePushService();
  const resolving = useRef(false);
  useEffect(() => {
    if (!isNativeIOS() || !canSign) return;
    let alive = true;
    const maintain = () => { void service?.maintain().catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Push registration needs attention.")); };
    const wake = async () => {
      if (!alive || resolving.current) return;
      resolving.current = true;
      try {
        const { wakeId } = await BuzzPush.getWake();
        if (!wakeId) return;
        const url = `${relayHttpBaseUrl().replace(/\/$/, "")}/api/push/wakes/${encodeURIComponent(wakeId)}`;
        const result = await fetch(url, { headers: await nip98Headers(url, "GET") });
        if (!alive) return;
        if (result.status === 404) {
          await router.navigate({ to: "/repos", search: { view: "inbox" } });
          toast.info("This notification is no longer available.");
        } else {
          if (!result.ok) throw new Error("Could not open this notification. Retry when connected.");
          const value = await result.json() as { v: number; event_id: string; channel_id: string | null };
          if (value.v !== 1 || !/^[a-f0-9]{64}$/.test(value.event_id)) throw new Error("Invalid notification response.");
          await router.navigate({ to: "/repos", search: value.channel_id ? { c: value.channel_id, m: value.event_id } : { view: "inbox" } });
        }
        await BuzzPush.acknowledgeWake({ wakeId });
      } catch (error) { if (alive) toast.error(error instanceof Error ? error.message : "Could not open notification."); }
      finally { resolving.current = false; }
    };
    const token = BuzzPush.addListener("token", maintain);
    const notification = BuzzPush.addListener("wake", () => void wake());
    const foreground = () => { if (!document.hidden) { maintain(); void wake(); } };
    document.addEventListener("visibilitychange", foreground);
    maintain(); void wake();
    setNativeBeforeForget(async () => { await service?.disable(); });
    return () => {
      alive = false; setNativeBeforeForget(null);
      document.removeEventListener("visibilitychange", foreground);
      void token.then((handle) => handle.remove()); void notification.then((handle) => handle.remove());
    };
  }, [canSign, service]);
  return null;
}

export function NativePushSettings() {
  const service = useNativePushService();
  const [status, setStatus] = useState<PushEnrollmentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void service?.status().then(setStatus).catch((reason: unknown) => setError(String(reason))); }, [service]);
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h2 className="font-medium">iPhone notifications</h2>
    <p className="text-sm text-muted-foreground">Receive mentions while Buzz is closed. Notifications contain no message text; opening one retrieves it from your relay.</p>
    {!service && <p className="text-sm">Configure your push gateway and sign in first.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <button type="button" className="rounded border border-border px-3 py-2 text-sm" disabled={!service || busy} onClick={() => {
      if (!service) return;
      setBusy(true); setError("");
      void (status?.enabled ? service.disable() : service.enable()).then(setStatus).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Push registration failed.")).finally(() => setBusy(false));
    }}>{busy ? "Updating…" : status?.enabled ? "Disable notifications" : "Enable notifications"}</button>
    {status?.pending && <p className="text-sm">Registration is waiting for relay acknowledgment.</p>}
  </section>;
}

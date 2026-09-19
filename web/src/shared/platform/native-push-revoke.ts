import { BuzzIdentity, BuzzPush } from "./native.ts";
import { readNativeServices } from "./config.ts";
import { createPushEnrollment } from "./push-enrollment.ts";
import { nip44EncryptTo, signNostrEvent } from "../lib/nostr-signer.ts";
import { nip98Headers } from "../lib/nip98.ts";

/** Independent of React/session lifetime: locked-start and lock-then-forget
 * must revoke the existing lease before the signing identity can be erased. */
export async function revokeNativePush(): Promise<void> {
  const services = readNativeServices();
  if (!services?.pushGatewayUrl) return;
  let identity = await BuzzIdentity.state();
  if (identity.locked) identity = await BuzzIdentity.unlock();
  if (!identity.pubkey) return;
  const { appProfile } = await BuzzPush.isSupported();
  if (appProfile !== "buzz-capacitor-ios-sandbox" && appProfile !== "buzz-capacitor-ios-production") throw new Error("Cannot revoke push: native installation profile unavailable.");
  const service = createPushEnrollment({ relayUrl: services.relayUrl, gatewayUrl: services.pushGatewayUrl,
    profile: appProfile, pubkey: identity.pubkey, plugin: BuzzPush,
    encrypt: (peer, plaintext) => nip44EncryptTo(plaintext, peer),
    publish: async (event) => {
      const signed = await signNostrEvent(event);
      const url = `${services.relayUrl.replace(/^wss:/, "https:").replace(/\/$/, "")}/events`;
      const body = JSON.stringify(signed);
      const response = await fetch(url, { method: "POST", headers: await nip98Headers(url, "POST", { body }), body });
      if (!response.ok) throw new Error("Push revocation failed. Your identity has been retained; reconnect and try again.");
      const value = await response.json() as { accepted?: boolean; message?: string };
      return { ok: value.accepted === true, message: value.message };
    },
  });
  await service.disable();
}

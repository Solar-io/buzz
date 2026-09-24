import type { RelaySession } from "@/shared/api/relay-session";
import {
  signNostrEvent,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "@/shared/lib/nostr-signer";

/**
 * Sign + publish one owner event and CHECK the relay's answer —
 * `RelaySession.publish` resolves `{ok:false}` on a rejection instead of
 * throwing (the send-path trap), so every web mutation goes through here.
 */
export async function publishSigned(
  session: RelaySession,
  template: UnsignedNostrEvent,
  rejected: string,
): Promise<
  { ok: true; signed: SignedNostrEvent } | { ok: false; error: string }
> {
  try {
    const signed = await signNostrEvent(template);
    const result = await session.publish(signed);
    if (!result.ok) {
      return { ok: false, error: result.message || rejected };
    }
    return { ok: true, signed };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : rejected,
    };
  }
}

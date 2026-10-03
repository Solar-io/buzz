import type { RelaySession } from "@/shared/api/relay-session";
import { nip44DecryptFrom, ownPubkey } from "@/shared/lib/nostr-signer";
import {
  ADMIN_ACK_KIND,
  parseAdminAck,
  type AdminAckEnvelope,
  type AdminCommand,
} from "../adminCommands";
import { sendAdminCommand } from "../adminCommandsSend";
import type { AdminSendOptions } from "./protocolV5";

/** Subscribe before publishing so a fast desktop reply cannot race its waiter. */
export async function requestAdminCommand(
  session: RelaySession,
  command: AdminCommand,
  options: AdminSendOptions,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<AdminAckEnvelope | null> {
  const pubkey = await ownPubkey();
  if (!pubkey || signal?.aborted) return null;
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe = () => {};
    const finish = (ack: AdminAckEnvelope | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      resolve(ack);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    unsubscribe = session.subscribe(
      { kinds: [ADMIN_ACK_KIND], authors: [pubkey] },
      {
        onEvent: async (event) => {
          if (finished || event.pubkey !== pubkey) return;
          try {
            const { plaintext } = await nip44DecryptFrom(event.content, pubkey);
            const ack = parseAdminAck(JSON.parse(plaintext));
            if (ack?.requestId === requestId) finish(ack);
          } catch {
            /* Not our ack. */
          }
        },
      },
    );
    void sendAdminCommand(session, command, { ...options, requestId, signal })
      .then((result) => {
        if (!result.ok) finish(null);
      })
      .catch(() => finish(null));
  });
}

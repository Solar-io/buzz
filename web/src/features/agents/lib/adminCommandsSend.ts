import { useEffect, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import {
  nip44DecryptFrom,
  nip44EncryptTo,
  ownPubkey,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import {
  ADMIN_ACK_KIND,
  ADMIN_COMMAND_KIND,
  AGENT_ADMIN_ACK_TYPE,
  AGENT_ADMIN_COMMAND_TYPE,
  parseAdminAck,
  type AdminAckEnvelope,
  type AdminCommand,
} from "./adminCommands";

/**
 * Seal + sign + publish one admin command (kind 24201, author-only fan-out,
 * NIP-44 sealed to the owner's own key — the desktop holds the same key).
 * Resolves when the relay accepts the event; the *application* verdict comes
 * back asynchronously as a kind-24202 ack.
 */
export async function sendAdminCommand(
  session: RelaySession,
  command: AdminCommand,
  options?: { target?: string },
): Promise<{ ok: boolean; requestId: string; message?: string }> {
  const pubkey = await ownPubkey();
  if (!pubkey) {
    return { ok: false, requestId: "", message: "No unlocked key." };
  }
  const requestId =
    globalThis.crypto?.randomUUID?.() ??
    `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const envelope = {
    type: AGENT_ADMIN_COMMAND_TYPE,
    action: command.action,
    requestId,
    issuedAt: new Date().toISOString(),
    // Machine targeting (kind-30180 catalog machine id): only the named
    // desktop applies + acks the command. Absent = legacy broadcast.
    ...(options?.target ? { target: options.target } : {}),
    request: command.request,
  };
  const { ciphertext } = nip44EncryptTo(JSON.stringify(envelope), pubkey);
  const event = await signNostrEvent({
    kind: ADMIN_COMMAND_KIND,
    tags: [],
    content: ciphertext,
  });
  const result = await session.publish(event);
  return {
    ok: result.ok,
    requestId,
    message: result.ok ? undefined : result.message,
  };
}

/**
 * Watch kind-24202 acks (author-only, sealed to self) and expose them by
 * request id. Mounted once by the agents page; senders read the map.
 */
export function useAdminAckWatcher(
  session: RelaySession | null,
  status: string,
): Map<string, AdminAckEnvelope> {
  const [acks, setAcks] = useState<Map<string, AdminAckEnvelope>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!session || status !== "open") {
      return;
    }
    let alive = true;
    let cleanup: (() => void) | null = null;
    void ownPubkey().then((pubkey) => {
      if (!alive || !pubkey) {
        return;
      }
      cleanup = session.subscribe(
        { kinds: [ADMIN_ACK_KIND], authors: [pubkey] },
        {
          onEvent: (event) => {
            try {
              const { plaintext } = nip44DecryptFrom(
                event.content,
                event.pubkey,
              );
              const ack = parseAdminAck(JSON.parse(plaintext));
              if (ack) {
                setAcks((previous) => {
                  const next = new Map(previous);
                  next.set(ack.requestId, ack);
                  return next;
                });
              }
            } catch {
              // Sealed to a different key or malformed — not ours, drop it.
            }
          },
        },
      );
    });
    return () => {
      alive = false;
      cleanup?.();
    };
  }, [session, status]);

  return acks;
}

/** Publish an ack (desktop-side symmetry helper; unused on the web). */
export async function publishAdminAck(
  session: RelaySession,
  ack: Omit<AdminAckEnvelope, "type">,
): Promise<void> {
  const pubkey = await ownPubkey();
  if (!pubkey) {
    throw new Error("No unlocked key.");
  }
  const envelope = { type: AGENT_ADMIN_ACK_TYPE, ...ack };
  const { ciphertext } = nip44EncryptTo(JSON.stringify(envelope), pubkey);
  const event = await signNostrEvent({
    kind: ADMIN_ACK_KIND,
    tags: [],
    content: ciphertext,
  });
  await session.publish(event);
}

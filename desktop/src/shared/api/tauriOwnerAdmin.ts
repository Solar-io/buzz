import type { RelayEvent } from "@/shared/api/types";
import { invokeTauri } from "./tauri";
import { relayClient } from "./relayClient";

/**
 * Owner admin-command primitives (kinds 24201/24202) — all crypto and
 * signing reuse existing Rust commands (`nip44_decrypt_from_self`,
 * `nip44_encrypt_to_self`, `sign_event`); nothing new Rust-side.
 */

export async function decryptOwnerAdminPayload(
  ciphertext: string,
): Promise<unknown> {
  const plaintext = await invokeTauri<string>("nip44_decrypt_from_self", {
    ciphertext,
  });
  return JSON.parse(plaintext);
}

export async function buildOwnerAdminAckEvent(ack: {
  requestId: string;
  ok: boolean;
  error?: string;
  agentPubkey?: string;
}): Promise<RelayEvent> {
  const payload = JSON.stringify({
    type: "agent_admin_ack",
    requestId: ack.requestId,
    ok: ack.ok,
    ...(ack.error ? { error: ack.error } : {}),
    ...(ack.agentPubkey ? { agentPubkey: ack.agentPubkey } : {}),
  });
  const ciphertext = await invokeTauri<string>("nip44_encrypt_to_self", {
    plaintext: payload,
  });
  const eventJson = await invokeTauri<string>("sign_event", {
    kind: 24202,
    content: ciphertext,
    createdAt: null,
    tags: [],
  });
  return JSON.parse(eventJson) as RelayEvent;
}

export async function publishOwnerAdminAck(ack: {
  requestId: string;
  ok: boolean;
  error?: string;
  agentPubkey?: string;
}): Promise<void> {
  await relayClient.preconnect();
  const event = await buildOwnerAdminAckEvent(ack);
  await relayClient.publishEvent(
    event,
    "Timed out while sending the admin ack.",
    "Failed to send the admin ack.",
  );
}

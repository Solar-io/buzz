/** Structured application verdict, serialized before NIP-44 sealing. */
export interface OwnerAdminAck {
  requestId: string;
  ok: boolean;
  error?: string;
  agentPubkey?: string;
  code?:
    | "unsupported"
    | "stale"
    | "conflict"
    | "invalid"
    | "failed"
    | "too_large"
    | "started";
  result?: Record<string, unknown>;
}

/** NIP-44 plaintext is bounded in UTF-8 bytes, not JavaScript characters. */
export function serializeOwnerAdminAck(ack: OwnerAdminAck): string {
  const payload = JSON.stringify({ type: "agent_admin_ack", ...ack });
  if (new TextEncoder().encode(payload).length <= 60_000) {
    return payload;
  }
  return JSON.stringify({
    type: "agent_admin_ack",
    requestId: ack.requestId,
    ok: false,
    code: "too_large",
    error: "The desktop response is too large.",
  });
}

/** Closed, ordered App Attest transcripts shared with the Rust gateway. */
export type GatewayChallenge = { challenge_id: string; challenge: string; expires_at: number };
export type PushSubscription = { filter: Record<string, unknown>; class: "default" | "silent" | "time_sensitive" };

export function enrollTranscript(c: GatewayChallenge, keyId: string, profile: string, token: string, expires: number): string {
  return `buzz.push.enroll.v1\n${JSON.stringify({v:1,audience:"https://push.buzz.xyz/v1/installations",challenge_id:c.challenge_id,challenge:c.challenge,key_id:keyId,app_profile:profile,endpoint:token,endpoint_epoch:1,expires_at:expires})}`;
}
export function delegateTranscript(c: GatewayChallenge, handle: string, epoch: number, generation: number, relay: string, now: number, expires: number): string {
  return `buzz.push.delegate.v1\n${JSON.stringify({v:1,audience:"https://push.buzz.xyz/v1/delegations",challenge_id:c.challenge_id,challenge:c.challenge,installation_handle:handle,endpoint_epoch:epoch,generation,relay_pubkey:relay,not_before:now,expires_at:expires})}`;
}
export function rotateTranscript(c: GatewayChallenge, handle: string, epoch: number, token: string): string {
  return `buzz.push.rotate-endpoint.v1\n${JSON.stringify({v:1,audience:"https://push.buzz.xyz/v1/installations/endpoint",challenge_id:c.challenge_id,challenge:c.challenge,installation_handle:handle,endpoint_epoch:epoch,new_endpoint_epoch:epoch+1,endpoint:token})}`;
}
export function revokeTranscript(c: GatewayChallenge, handle: string, relay: string, generation: number): string {
  return `buzz.push.revoke-delegation.v1\n${JSON.stringify({v:1,audience:"https://push.buzz.xyz/v1/delegations/revoke",challenge_id:c.challenge_id,challenge:c.challenge,installation_handle:handle,relay_pubkey:relay,generation})}`;
}

/** App Attest takes SHA-256 bytes, encoded only for the native bridge. */
export async function transcriptHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/**
 * The signed tag set for one NIP-98 request.
 *
 * Pure and exported so the nonce invariant is testable: the nonce is
 * unconditional, not body-only. Without it two GETs to the same URL inside
 * the same second sign byte-identical events — same kind, tags, content,
 * pubkey and `created_at` — so they share an id and the relay's replay guard
 * (`check_nip98_replay` in `api/bridge.rs`) rejects the second. Any endpoint
 * polled on a timer hits that, and the failure reads as an auth error rather
 * than a collision.
 */
export function buildNip98Tags(
  url: string,
  method: string,
  payloadHash: string | undefined,
  nonce: string,
): string[][] {
  const tags = [
    ["u", url],
    ["method", method],
    ["nonce", nonce],
  ];
  if (payloadHash !== undefined) {
    tags.push(["payload", payloadHash]);
  }
  return tags;
}

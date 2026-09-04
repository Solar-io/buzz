/**
 * The network half of invite minting, kept apart from `lib/inviteMint.ts` so
 * the validation and parsing there stay loadable by `node --test`.
 */

import { nip98Headers } from "@/shared/lib/nip98";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import {
  parseMintedInvite,
  validateMintRequest,
  type MintedInvite,
  type MintInviteRequest,
} from "./lib/inviteMint.ts";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Mint an invite. Rejects with the relay's own message on a refusal — a
 * non-admin gets "only relay owners and admins can create invites", which is
 * the accurate thing to show.
 */
export async function mintInvite(
  request: MintInviteRequest,
): Promise<MintedInvite> {
  const issue = validateMintRequest(request);
  if (issue) throw new Error(issue);

  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/api/invites`;
  const body = JSON.stringify({
    ...(request.ttlSecs !== undefined ? { ttl_secs: request.ttlSecs } : {}),
    ...(request.maxUses !== undefined && request.maxUses !== null
      ? { max_uses: request.maxUses }
      : {}),
  });
  const response = await fetch(url, {
    method: "POST",
    headers: await nip98Headers(url, "POST", { body }),
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof json.error === "string" ? json.error : `HTTP ${response.status}`,
    );
  }
  const invite = parseMintedInvite(json);
  if (!invite) throw new Error("The relay returned an invite it cannot read.");
  return invite;
}

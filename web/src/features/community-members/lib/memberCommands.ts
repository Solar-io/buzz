/**
 * Relay-admin command templates (kinds 9030 / 9031 / 9032).
 *
 * These are ordinary signed events on the normal publish path — there is no
 * privileged transport. The relay processes them directly and never stores
 * them (`handlers/relay_admin.rs`), answering `OK false <reason>` on refusal,
 * and the reason text is client-safe by contract, so callers surface it
 * verbatim rather than inventing a generic failure.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

import {
  KIND_ADD_MEMBER,
  KIND_CHANGE_ROLE,
  KIND_REMOVE_MEMBER,
  type CommunityRole,
} from "./members.ts";

export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/**
 * The relay reads the target from the first `p` tag and requires exactly 64
 * hex characters (`extract_p_tag_hex`), so anything else is rejected here
 * rather than sent to be refused.
 */
function targetTag(pubkey: string): string[] {
  const normalized = pubkey.trim().toLowerCase();
  if (!HEX_PUBKEY.test(normalized)) {
    throw new Error("A public key must be 64 hex characters.");
  }
  return ["p", normalized];
}

/**
 * Add someone to the community.
 *
 * `role` is `member` or `admin`; `owner` is refused by the relay outright.
 * Omitting the role tag would default to `member` server-side, but it is
 * always written so the intent is on the wire and in the relay's audit line.
 */
export function buildAddMemberEvent(input: {
  pubkey: string;
  role: Exclude<CommunityRole, "owner">;
}): EventTemplate {
  return {
    kind: KIND_ADD_MEMBER,
    content: "",
    tags: [targetTag(input.pubkey), ["role", input.role]],
  };
}

/** Remove someone. No role tag: the relay decides from the sender's role. */
export function buildRemoveMemberEvent(pubkey: string): EventTemplate {
  return {
    kind: KIND_REMOVE_MEMBER,
    content: "",
    tags: [targetTag(pubkey)],
  };
}

/** Promote or demote. Owner-only, and never to `owner`. */
export function buildChangeRoleEvent(input: {
  pubkey: string;
  role: Exclude<CommunityRole, "owner">;
}): EventTemplate {
  return {
    kind: KIND_CHANGE_ROLE,
    content: "",
    tags: [targetTag(input.pubkey), ["role", input.role]],
  };
}

/**
 * NIP-OA owner attestation — the half that decides who may archive an agent.
 *
 * Transcribed from `crates/buzz-sdk/src/nip_oa.rs`:
 *
 *   tag      = ["auth", "<owner-pubkey-hex>", "<conditions>", "<sig-hex>"]
 *   preimage = "nostr:agent-auth:" || agent_pubkey_hex || ":" || conditions
 *   message  = SHA256(preimage)
 *   sig      = BIP-340 Schnorr(message, owner_secret_key)
 *
 * The subject of the preimage is the **target** pubkey, not the request
 * signer — the spec's own gotcha #3, and the mistake that would make every
 * attestation verify against the wrong key while still looking plausible.
 *
 * Verification is injected rather than imported so this module stays loadable
 * by `node --test`; `useIdentityArchive` supplies the real schnorr verifier.
 * That injection is not a test seam for its own sake: the relay performs the
 * authoritative check on submit, so what happens here only decides whether a
 * button is rendered.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export type AuthTag = [string, string, string, string];

/** The exact bytes signed by the owner. */
export function ownerAuthPreimage(
  agentPubkeyHex: string,
  conditions: string,
): string {
  return `nostr:agent-auth:${agentPubkeyHex.toLowerCase()}:${conditions}`;
}

/**
 * `validate_conditions` — empty is valid; otherwise `clause&clause&…` where a
 * clause is `kind=<0-65535>`, `created_at<<u32>` or `created_at><u32>`, in
 * canonical decimal (no leading zeros) and with no whitespace anywhere.
 */
export function conditionsIssue(conditions: string): string | null {
  if (conditions.length === 0) return null;
  if (/\s/.test(conditions)) {
    return "conditions must not contain whitespace";
  }
  for (const clause of conditions.split("&")) {
    if (clause.length === 0) {
      return "empty clause in conditions (leading/trailing/double '&')";
    }
    const issue = clauseIssue(clause);
    if (issue) return issue;
  }
  return null;
}

function canonicalDecimalIssue(
  value: string,
  max: number,
  label: string,
): string | null {
  if (value.length === 0) return `${label} value must not be empty`;
  if (!/^[0-9]+$/.test(value)) return `${label} value must be decimal`;
  if (value.length > 1 && value.startsWith("0")) {
    return `${label} value must not have leading zeros`;
  }
  if (Number(value) > max) return `${label} value out of range`;
  return null;
}

function clauseIssue(clause: string): string | null {
  if (clause.startsWith("kind=")) {
    return canonicalDecimalIssue(clause.slice(5), 65535, "kind");
  }
  if (clause.startsWith("created_at<")) {
    return canonicalDecimalIssue(clause.slice(11), 4294967295, "created_at<");
  }
  if (clause.startsWith("created_at>")) {
    return canonicalDecimalIssue(clause.slice(11), 4294967295, "created_at>");
  }
  return `unsupported clause: "${clause}"`;
}

/** Structural check only — shape, casing, and lengths. */
export function authTagShapeIssue(tag: readonly string[]): string | null {
  if (tag.length !== 4) return "auth tag must have exactly 4 elements";
  if (tag[0] !== "auth") return `auth tag label must be "auth"`;
  if (!HEX64.test(tag[1].toLowerCase())) {
    return "auth tag owner pubkey must be 64 hex characters";
  }
  if (!HEX128.test(tag[3].toLowerCase())) {
    return "auth tag signature must be 128-character hex";
  }
  return conditionsIssue(tag[2]);
}

export interface OwnerOfAgent {
  /** Verified owner pubkey (hex) recovered from the target's `auth` tag. */
  owner: string;
  /** True iff `owner` is the current viewer. */
  isMe: boolean;
  /** The raw tag, forwarded on the owner consent path. */
  tag: AuthTag;
}

export interface Kind0Event {
  pubkey: string;
  tags: string[][];
}

/**
 * Resolve the verified NIP-OA owner from a target's live kind:0.
 *
 * Scans every `auth` tag and returns the first that verifies, matching
 * `extract_oa_owner`'s loop — a profile may legitimately carry more than one
 * attestation, and stopping at the first malformed one would lose a valid
 * later entry.
 */
export function resolveOaOwner(
  targetKind0: Kind0Event | null,
  viewerPubkey: string | null,
  verify: (input: {
    preimage: string;
    ownerPubkeyHex: string;
    signatureHex: string;
  }) => boolean,
): OwnerOfAgent | null {
  if (!targetKind0) return null;
  const target = targetKind0.pubkey.toLowerCase();
  for (const tag of targetKind0.tags) {
    if (!Array.isArray(tag) || tag[0] !== "auth") continue;
    if (authTagShapeIssue(tag) !== null) continue;
    const owner = tag[1].toLowerCase();
    const ok = verify({
      preimage: ownerAuthPreimage(target, tag[2]),
      ownerPubkeyHex: owner,
      signatureHex: tag[3].toLowerCase(),
    });
    if (!ok) continue;
    return {
      owner,
      isMe: viewerPubkey?.toLowerCase() === owner,
      tag: [tag[0], tag[1], tag[2], tag[3]] as AuthTag,
    };
  }
  return null;
}

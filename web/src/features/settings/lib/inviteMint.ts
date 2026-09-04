/**
 * Minting community invites — the request half.
 *
 * `POST /api/invites` is NIP-98 signed and owner/admin only
 * (`crates/buzz-relay/src/api/invites.rs:276`). The browser can do all of it:
 * the web client already mints NIP-98 headers for the *claim* side, and
 * minting is the same shape with a different path.
 *
 * The bounds below are the relay's own, from `buzz-core/src/invite.rs`. They
 * are duplicated here so the form can refuse an impossible value before a
 * round-trip — and only for that. The relay revalidates
 * (`validate_mint_request`), so this copy is a convenience, never the control.
 *
 * `validateMintRequest` is import-free; the network call lives below it.
 */

/** `MIN_INVITE_TTL_SECS` — one minute. */
export const MIN_INVITE_TTL_SECS = 60;
/** `DEFAULT_INVITE_TTL_SECS` — 72 hours. */
export const DEFAULT_INVITE_TTL_SECS = 72 * 60 * 60;
/** `MAX_INVITE_TTL_SECS` — 30 days. */
export const MAX_INVITE_TTL_SECS = 30 * 24 * 60 * 60;
/** `MAX_INVITE_USES`. */
export const MAX_INVITE_USES = 10_000;

export interface MintInviteRequest {
  /** Seconds. Omitted means the relay's 72-hour default. */
  ttlSecs?: number;
  /** Omitted (or null) means unlimited uses. */
  maxUses?: number | null;
}

/**
 * Mirror of the relay's `validate_mint_request`, error strings included, so a
 * rejection reads the same whether it was caught here or there.
 */
export function validateMintRequest(request: MintInviteRequest): string | null {
  const ttl = request.ttlSecs ?? DEFAULT_INVITE_TTL_SECS;
  if (
    !Number.isInteger(ttl) ||
    ttl < MIN_INVITE_TTL_SECS ||
    ttl > MAX_INVITE_TTL_SECS
  ) {
    return `ttl_secs must be between ${MIN_INVITE_TTL_SECS} and ${MAX_INVITE_TTL_SECS}`;
  }
  const maxUses = request.maxUses;
  if (maxUses !== undefined && maxUses !== null) {
    if (
      !Number.isInteger(maxUses) ||
      maxUses < 1 ||
      maxUses > MAX_INVITE_USES
    ) {
      return `max_uses must be between 1 and ${MAX_INVITE_USES}`;
    }
  }
  return null;
}

/** The relay's response contract for a minted invite. */
export interface MintedInvite {
  code: string;
  /** Unix seconds. */
  expiresAt: number;
  maxUses: number | null;
  usesRemaining: number | null;
  /** Shareable landing page on the community's own host. */
  url: string;
}

export function parseMintedInvite(json: unknown): MintedInvite | null {
  if (typeof json !== "object" || json === null) return null;
  const raw = json as Record<string, unknown>;
  if (typeof raw.code !== "string" || typeof raw.url !== "string") return null;
  return {
    code: raw.code,
    expiresAt: typeof raw.expires_at === "number" ? raw.expires_at : 0,
    maxUses: typeof raw.max_uses === "number" ? raw.max_uses : null,
    usesRemaining:
      typeof raw.uses_remaining === "number" ? raw.uses_remaining : null,
    url: raw.url,
  };
}

/** Human label for a TTL, used by the form's preset list. */
export function describeTtl(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export const TTL_PRESETS = [
  60 * 60,
  24 * 60 * 60,
  DEFAULT_INVITE_TTL_SECS,
  7 * 24 * 60 * 60,
  MAX_INVITE_TTL_SECS,
] as const;

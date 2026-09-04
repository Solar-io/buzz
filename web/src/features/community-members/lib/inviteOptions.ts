/**
 * Invite-link options and their relay-side bounds.
 *
 * The bounds are the relay's, mirrored so a bad request is refused in the
 * dialog rather than round-tripped for a 400 (`buzz-core/src/invite.rs`:
 * `MIN_INVITE_TTL_SECS` 60, `MAX_INVITE_TTL_SECS` 30 days, `MAX_INVITE_USES`
 * 10 000; the relay's own default TTL is 72 h).
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export const MIN_INVITE_TTL_SECS = 60;
export const MAX_INVITE_TTL_SECS = 30 * 24 * 60 * 60;
export const MAX_INVITE_USES = 10_000;

export const INVITE_TTL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "1 day", value: 24 * 60 * 60 },
  { label: "3 days", value: 3 * 24 * 60 * 60 },
  { label: "7 days", value: 7 * 24 * 60 * 60 },
  { label: "30 days", value: 30 * 24 * 60 * 60 },
];

/** The relay's own default is 72 h; the picker's default matches it. */
export const DEFAULT_INVITE_TTL_SECS = INVITE_TTL_OPTIONS[1].value;

export const INVITE_USE_OPTIONS: Array<{
  label: string;
  value: number | null;
}> = [
  { label: "No limit", value: null },
  { label: "1 use", value: 1 },
  { label: "5 uses", value: 5 },
  { label: "25 uses", value: 25 },
];

export interface MintInviteOptions {
  ttlSecs: number;
  /** null = unlimited, which is what omitting the field means to the relay. */
  maxUses: number | null;
}

/**
 * Validate before sending. Returns the message to show, or null when valid.
 *
 * `max_uses` must be an integer: the relay deserializes it as `i32`, so `2.5`
 * fails as a JSON type error whose message reads like a malformed request.
 */
export function validateInviteOptions(
  options: MintInviteOptions,
): string | null {
  if (
    !Number.isInteger(options.ttlSecs) ||
    options.ttlSecs < MIN_INVITE_TTL_SECS ||
    options.ttlSecs > MAX_INVITE_TTL_SECS
  ) {
    return `An invite must last between ${MIN_INVITE_TTL_SECS} seconds and 30 days.`;
  }
  if (options.maxUses === null) {
    return null;
  }
  if (
    !Number.isInteger(options.maxUses) ||
    options.maxUses < 1 ||
    options.maxUses > MAX_INVITE_USES
  ) {
    return `A use limit must be a whole number from 1 to ${MAX_INVITE_USES}.`;
  }
  return null;
}

/** Request body for `POST /api/invites`, omitting an unlimited `max_uses`. */
export function mintInviteBody(options: MintInviteOptions): string {
  const body: { ttl_secs: number; max_uses?: number } = {
    ttl_secs: options.ttlSecs,
  };
  if (options.maxUses !== null) {
    body.max_uses = options.maxUses;
  }
  return JSON.stringify(body);
}

export interface MintedInvite {
  code: string;
  url: string;
  expiresAt: number;
  maxUses: number | null;
  usesRemaining: number | null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Shape a mint response.
 *
 * The relay's `url` is built from the *tenant host* it knows about, which on a
 * split deployment is not necessarily the origin this tab was served from.
 * A caller may therefore prefer to rebuild the link locally; `code` is always
 * the authoritative half.
 */
export function mintedInviteFromResponse(json: unknown): MintedInvite | null {
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const raw = json as Record<string, unknown>;
  if (typeof raw.code !== "string" || raw.code.length === 0) {
    return null;
  }
  return {
    code: raw.code,
    url: typeof raw.url === "string" ? raw.url : "",
    expiresAt: typeof raw.expires_at === "number" ? raw.expires_at : 0,
    maxUses: optionalCount(raw.max_uses),
    usesRemaining: optionalCount(raw.uses_remaining),
  };
}

/** Same-origin invite link for a code, for deployments the relay mis-hosts. */
export function inviteUrlForCode(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/invite/${encodeURIComponent(code)}`;
}

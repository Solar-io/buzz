/**
 * NIP-05 verification.
 *
 * A `nip05` field in kind:0 is a *claim* — "I am alice@example.com" — and any
 * key can publish any string there. The claim is only worth showing once the
 * named domain has been asked whether it agrees, which is what NIP-05 defines:
 * `GET https://<domain>/.well-known/nostr.json?name=<local>` must map the local
 * part to this exact pubkey.
 *
 * Rendering an unverified `nip05` as if it were an identity — which the web
 * client does today, and the desktop does too — is the whole reason this
 * exists: an attacker publishes `nip05: "sam@block.xyz"`, and every surface
 * that prints the field without checking has just labelled them Sam.
 *
 * This module is the pure half: parsing, URL construction, and reading a
 * response. The fetch lives in the hook, so `node --test` can load this
 * directly.
 */

export interface Nip05Address {
  /** Local part; `_` is the domain-root name NIP-05 defines. */
  name: string;
  domain: string;
}

/**
 * Split `name@domain`, or return null.
 *
 * The local part is restricted to `a-z0-9-_.` by NIP-05 itself; anything else
 * is rejected rather than URL-escaped, because a `nip05` claim containing a
 * path separator or a query character is trying to steer the request
 * somewhere the spec does not allow.
 */
export function parseNip05(raw: string): Nip05Address | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }
  const at = trimmed.lastIndexOf("@");
  // A bare domain means the `_` root name, which NIP-05 renders as "@domain".
  const name = at === -1 ? "_" : trimmed.slice(0, at);
  const domain = at === -1 ? trimmed : trimmed.slice(at + 1);
  if (!/^[a-z0-9\-_.]+$/.test(name)) {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return null;
  }
  return { name, domain };
}

/** The well-known URL for an address. Always https — NIP-05 requires it. */
export function nip05Url(address: Nip05Address): string {
  return `https://${address.domain}/.well-known/nostr.json?name=${encodeURIComponent(address.name)}`;
}

/** How a claim reads once the domain has (or has not) answered. */
export type Nip05Status =
  | "none"
  | "checking"
  | "verified"
  | "mismatch"
  | "unreachable"
  | "malformed";

/**
 * Read a `.well-known/nostr.json` body.
 *
 * Returns "verified" only on an exact, case-insensitive pubkey match for this
 * name. A body that lists the name under a *different* key is a `mismatch` —
 * an active impersonation attempt or a stale record — and is reported as such
 * rather than as an outage, because the two mean opposite things to a reader.
 */
export function readNip05Response(
  body: unknown,
  address: Nip05Address,
  pubkey: string,
): Nip05Status {
  if (typeof body !== "object" || body === null) {
    return "malformed";
  }
  const names = (body as { names?: unknown }).names;
  if (typeof names !== "object" || names === null || Array.isArray(names)) {
    return "malformed";
  }
  const claimed = (names as Record<string, unknown>)[address.name];
  if (typeof claimed !== "string") {
    return "mismatch";
  }
  return claimed.toLowerCase() === pubkey.trim().toLowerCase()
    ? "verified"
    : "mismatch";
}

/** Short human label for a status, for the badge beside the handle. */
export function nip05Label(status: Nip05Status): string {
  switch (status) {
    case "verified":
      return "Verified by the domain";
    case "mismatch":
      return "The domain does not confirm this name";
    case "unreachable":
      return "The domain did not answer";
    case "malformed":
      return "The domain's reply was not readable";
    case "checking":
      return "Checking with the domain…";
    default:
      return "";
  }
}

/**
 * How the claim should be presented.
 *
 * Unverified is not the same as false, so an unreachable domain is shown
 * plainly rather than struck through — but it is never shown as verified.
 */
export function nip05Tone(status: Nip05Status): "good" | "bad" | "neutral" {
  if (status === "verified") {
    return "good";
  }
  if (status === "mismatch") {
    return "bad";
  }
  return "neutral";
}

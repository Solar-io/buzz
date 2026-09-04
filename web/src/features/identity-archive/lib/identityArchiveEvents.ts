/**
 * NIP-IA identity archival — the wire shapes.
 *
 * Ported tag-for-tag from `desktop/src-tauri/src/events.rs`
 * (`identity_archive_tags`, `build_archive_identity_request`,
 * `build_unarchive_identity_request`) and from
 * `commands/identity_archive.rs::archived_pubkeys_from_snapshot`.
 *
 * Three details are load-bearing and easy to lose in a port:
 *
 * - The **`["-"]` NIP-70 tag comes first** and marks the request as protected
 *   administrative state. Dropping it changes how the relay treats the event.
 * - The self path has `actor == target`, so the request carries a `p` tag
 *   naming its own signer. The desktop needs `.allow_self_tagging()` because
 *   nostr 0.44 strips such a tag by default; nothing strips tags here, but the
 *   same wire form is what the relay expects, and the self path is the *whole*
 *   anti-shadowban property of the NIP — an archived user must be able to see
 *   and undo their own archival.
 * - The snapshot (kind 13535) is **relay-authoritative**: only one signed by
 *   the pubkey the relay advertises as `self` in its NIP-11 document may
 *   affect archive state. Every failure path fails OPEN (nobody archived)
 *   rather than trusting an unverified list — see `snapshotArchivedPubkeys`.
 *
 * Import-free so `node --test` can load it.
 */

export const KIND_IA_ARCHIVE_REQUEST = 9035;
export const KIND_IA_UNARCHIVE_REQUEST = 9036;
export const KIND_IA_ARCHIVED_LIST = 13535;

/** Machine-readable reason codes the desktop offers; free text is also legal. */
export const ARCHIVE_REASONS = [
  "rotated",
  "retired",
  "bot-rebuilt",
  "left-organization",
  "spam",
] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_REASON_LEN = 64;
/** `check_content` in events.rs — the relay caps request content. */
const MAX_CONTENT_LEN = 4096;

export type AuthTag = [string, string, string, string];

export interface UnsignedEventTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

export interface ArchiveRequestInput {
  targetPubkey: string;
  content?: string;
  reason?: string;
  replacedBy?: string;
  auth?: AuthTag;
}

/** `check_pubkey` — 64 lowercase-able hex characters. */
export function pubkeyIssue(value: string, label = "pubkey"): string | null {
  if (!HEX64.test(value.toLowerCase())) {
    return `${label} must be 64 hex characters`;
  }
  return null;
}

/** `check_reason` — at most 64 chars, no control characters. */
export function reasonIssue(reason: string): string | null {
  if (reason.length > MAX_REASON_LEN) {
    return `reason code exceeds maximum length of ${MAX_REASON_LEN} chars (got ${reason.length})`;
  }
  // Rust's `char::is_control` is the Unicode Cc category: C0, DEL, and C1.
  // Written as a code-point scan rather than a character-class regex because
  // the escapes for those ranges are exactly what `noControlCharactersInRegex`
  // exists to catch, and silencing that rule to express a control-character
  // check would be the wrong trade.
  for (const character of reason) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return "reason code must not contain control characters";
    }
  }
  return null;
}

function contentIssue(content: string): string | null {
  return content.length > MAX_CONTENT_LEN
    ? `content exceeds maximum length of ${MAX_CONTENT_LEN} chars`
    : null;
}

function authTagIssue(auth: AuthTag): string | null {
  if (auth[0] !== "auth") {
    return `auth tag label must be "auth" (got "${auth[0]}")`;
  }
  const ownerIssue = pubkeyIssue(auth[1], "auth tag owner pubkey");
  if (ownerIssue) return ownerIssue;
  if (!HEX128.test(auth[3].toLowerCase())) {
    return "auth tag signature must be 128-character hex";
  }
  return null;
}

/**
 * The shared tag list for both request kinds. `replacedBy` is only meaningful
 * on archive; `buildUnarchiveRequest` never passes it, matching the spec note
 * that `replaced-by` has no defined meaning on unarchive.
 */
function identityArchiveTags(
  input: ArchiveRequestInput,
  allowReplacedBy: boolean,
): { tags: string[][] } | { error: string } {
  const targetIssue = pubkeyIssue(input.targetPubkey, "target_pubkey");
  if (targetIssue) return { error: targetIssue };
  const target = input.targetPubkey.toLowerCase();

  const tags: string[][] = [["-"], ["p", target]];

  if (input.reason !== undefined && input.reason.length > 0) {
    const issue = reasonIssue(input.reason);
    if (issue) return { error: issue };
    tags.push(["reason", input.reason]);
  }

  if (allowReplacedBy && input.replacedBy) {
    const issue = pubkeyIssue(input.replacedBy, "replaced-by");
    if (issue) return { error: issue };
    const replacedBy = input.replacedBy.toLowerCase();
    if (replacedBy === target) {
      return { error: "replaced-by must differ from the target" };
    }
    tags.push(["replaced-by", replacedBy]);
  }

  if (input.auth) {
    const issue = authTagIssue(input.auth);
    if (issue) return { error: issue };
    tags.push(["auth", input.auth[1], input.auth[2], input.auth[3]]);
  }

  return { tags };
}

/** Kind 9035 — NIP-IA archive request. */
export function buildArchiveRequest(
  input: ArchiveRequestInput,
): { event: UnsignedEventTemplate } | { error: string } {
  const content = input.content ?? "";
  const issue = contentIssue(content);
  if (issue) return { error: issue };
  const built = identityArchiveTags(input, true);
  if ("error" in built) return built;
  return {
    event: { kind: KIND_IA_ARCHIVE_REQUEST, tags: built.tags, content },
  };
}

/** Kind 9036 — NIP-IA unarchive request. */
export function buildUnarchiveRequest(
  input: ArchiveRequestInput,
): { event: UnsignedEventTemplate } | { error: string } {
  const content = input.content ?? "";
  const issue = contentIssue(content);
  if (issue) return { error: issue };
  const built = identityArchiveTags(input, false);
  if ("error" in built) return built;
  return {
    event: { kind: KIND_IA_UNARCHIVE_REQUEST, tags: built.tags, content },
  };
}

export interface SnapshotEvent {
  kind: number;
  pubkey: string;
  tags: string[][];
}

/**
 * The archived set from a kind-13535 snapshot, given the relay's advertised
 * `self` pubkey and a signature verifier.
 *
 * Returns `[]` — nobody archived — for every failure: wrong kind, no
 * advertised signer, an author other than that signer, or a bad signature.
 * Per NIP-IA §Client Behavior only a relay-signed snapshot may affect archive
 * state, and failing OPEN is the safe direction: a client that guessed
 * "archived" from an unverified list would hide people on a forged event.
 */
export function snapshotArchivedPubkeys(
  snapshot: SnapshotEvent | null,
  relaySelf: string | null,
  verify: (event: SnapshotEvent) => boolean,
): string[] {
  if (!snapshot || !relaySelf) return [];
  if (snapshot.kind !== KIND_IA_ARCHIVED_LIST) return [];
  if (snapshot.pubkey.toLowerCase() !== relaySelf.toLowerCase()) return [];
  if (!verify(snapshot)) return [];
  const out: string[] = [];
  for (const tag of snapshot.tags) {
    if (!Array.isArray(tag) || tag[0] !== "p" || typeof tag[1] !== "string") {
      continue;
    }
    const pubkey = tag[1].toLowerCase();
    if (HEX64.test(pubkey) && !out.includes(pubkey)) out.push(pubkey);
  }
  return out;
}

/**
 * Whether `pubkey` should be folded out of forward-looking discovery.
 *
 * Self-exempt by construction: the current user is never hidden from their own
 * client even when archived. NIP-IA §Self Requests makes archival deliberately
 * non-silent — the anti-shadowban property requires the archived user to SEE
 * that they are archived and to self-unarchive. Folding self would build the
 * exact shadowban the NIP prevents, so the exemption lives here, in the
 * predicate, where no caller can forget it.
 */
export function makeArchivedPredicate(
  archived: readonly string[],
  selfPubkey: string | null,
): (pubkey: string) => boolean {
  const set = new Set(archived.map((entry) => entry.toLowerCase()));
  const self = selfPubkey?.toLowerCase() ?? null;
  return (pubkey: string) => {
    const lower = pubkey.toLowerCase();
    return lower !== self && set.has(lower);
  };
}

/**
 * Render gate for the archive controls, mirroring `useIdentityArchive`.
 *
 * The relay re-verifies authority on submit; this only decides whether to show
 * a control that would be refused. Three consent paths: yourself, a relay
 * owner/admin, or the verified NIP-OA owner of the target.
 */
export function canArchive(input: {
  targetPubkey: string | null;
  selfPubkey: string | null;
  communityRole: "owner" | "admin" | "member" | null;
  isOaOwnerOfTarget: boolean;
}): boolean {
  const target = input.targetPubkey?.trim().toLowerCase() ?? "";
  if (target.length === 0) return false;
  const isSelf = input.selfPubkey?.toLowerCase() === target;
  const isRelayAdmin =
    input.communityRole === "owner" || input.communityRole === "admin";
  return isSelf || isRelayAdmin || input.isOaOwnerOfTarget;
}

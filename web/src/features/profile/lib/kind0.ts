/**
 * Nostr kind-0 (profile metadata) parsing and serialisation.
 *
 * Kind 0 is a *replaceable* event: publishing one replaces the author's
 * previous metadata wholesale. That makes serialisation the risky half of
 * this module — a naive writer that emits only the fields this client knows
 * about silently deletes every field it does not (`lud16`, `banner`,
 * whatever a future NIP adds), and the user has no way to tell.
 * `serializeProfileContent` therefore edits the *previous* content object
 * rather than building a fresh one.
 *
 * Pure logic only — no React, no relay, no path aliases — so the colocated
 * `node --test` suite can import it directly.
 */

/** The kind-0 fields this client reads. Absent fields read as `""`. */
export interface ProfileMetadata {
  /** NIP-01 `name` — the handle. */
  name: string;
  /** NIP-01 `display_name` — the pretty name. */
  displayName: string;
  /** NIP-01 `about` — free-text bio. */
  about: string;
  /** NIP-01 `picture` — avatar URL. */
  picture: string;
  /** NIP-05 identifier (`user@domain`), when published. */
  nip05: string;
  /** NIP-01 `website`. */
  website: string;
}

export const EMPTY_PROFILE_METADATA: ProfileMetadata = {
  name: "",
  displayName: "",
  about: "",
  picture: "",
  nip05: "",
  website: "",
};

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/**
 * The JSON object behind a kind-0 content string, or null when unusable.
 *
 * Arrays and scalars are rejected as well as invalid JSON: `JSON.parse("3")`
 * succeeds, and spreading a number into the serialiser's merge target would
 * quietly produce `{}` instead of failing.
 */
export function parseProfileObject(
  content: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read a kind-0 `content` payload.
 *
 * Never throws: malformed JSON, a JSON scalar, or `null` all degrade to
 * {@link EMPTY_PROFILE_METADATA}, because a broken profile must render as an
 * anonymous one rather than blanking the row that hosts it.
 */
export function parseProfileContent(content: string): ProfileMetadata {
  const object = parseProfileObject(content);
  if (!object) {
    return { ...EMPTY_PROFILE_METADATA };
  }
  return {
    name: readString(object, "name"),
    displayName: readString(object, "display_name"),
    about: readString(object, "about"),
    picture: readString(object, "picture"),
    nip05: readString(object, "nip05"),
    website: readString(object, "website"),
  };
}

/**
 * The best display label for a profile: `display_name`, then `name`, then the
 * caller's fallback (normally the truncated key). Trims, so a profile whose
 * `display_name` is whitespace falls through instead of rendering blank.
 */
export function profileLabel(
  metadata: ProfileMetadata,
  fallback: string,
): string {
  return metadata.displayName.trim() || metadata.name.trim() || fallback;
}

/** The editable subset of a profile — everything this client's form writes. */
export interface ProfileDraft {
  displayName: string;
  about: string;
  picture: string;
}

function assign(
  target: Record<string, unknown>,
  key: string,
  value: string,
): void {
  if (value) {
    target[key] = value;
  } else {
    delete target[key];
  }
}

/**
 * Build the `content` for a kind-0 publish.
 *
 * Semantics, all of them deliberate:
 *
 * - Unknown keys in `previousContent` are carried through untouched. Kind 0
 *   is replaceable; dropping them would be silent data loss.
 * - An empty draft field *removes* its key rather than writing `""`, so
 *   "clear my bio" produces an absent `about`, which is what other clients
 *   treat as unset.
 * - `name` is only written when the previous content had none. A user who set
 *   a distinct handle elsewhere keeps it; a user who has only ever had a
 *   display name gets `name` seeded to match, so name-only readers (the web's
 *   own `useProfiles` fallback chain included) show something.
 */
export function serializeProfileContent(
  draft: ProfileDraft,
  previousContent: string | null,
): string {
  const previous = previousContent ? parseProfileObject(previousContent) : null;
  const next: Record<string, unknown> = { ...(previous ?? {}) };

  const displayName = draft.displayName.trim();
  const about = draft.about.trim();
  const picture = draft.picture.trim();

  assign(next, "display_name", displayName);
  assign(next, "about", about);
  assign(next, "picture", picture);

  if (displayName && typeof next.name !== "string") {
    next.name = displayName;
  }

  return JSON.stringify(next);
}

/** A kind-0 event as this module needs to see it. */
export interface ProfileEventLike {
  pubkey: string;
  created_at: number;
  content: string;
}

/**
 * Latest-wins across a relay's kind-0 echoes for one author.
 *
 * Relays replay replaceable events out of order often enough that first-seen
 * (what `features/channels/hooks.ts` does) can pin a stale name for the rest
 * of the session — and the edit form reads this value as its starting point,
 * so a stale pin there would republish yesterday's bio. Ties break toward the
 * incoming event, matching "last writer within the same second wins".
 */
export function pickLatestProfileEvent<T extends ProfileEventLike>(
  current: T | null,
  incoming: T,
): T {
  if (!current) {
    return incoming;
  }
  return incoming.created_at >= current.created_at ? incoming : current;
}

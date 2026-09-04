/**
 * NIP-38 user status (kind 30315) — the wire format, read off the Rust rather
 * than guessed.
 *
 * Source of truth, in order:
 *
 *  - `crates/buzz-core/src/kind.rs:70` — `KIND_USER_STATUS: u32 = 30315`,
 *    documented there as "parameterized replaceable (NIP-33), keyed by
 *    `(pubkey, kind, d_tag)`, stored globally (channel_id = NULL)". So it
 *    carries NO `h` tag: `is_global_only_kind` in the relay's ingest path
 *    lists 30315, and a stray `h` would be rejected as channel-scoping a
 *    global-only kind.
 *  - `crates/buzz-sdk/src/builders.rs:1716-1730` (`build_user_status`) —
 *    tags are `["d", "general"]` plus, when non-blank, `["emoji", <emoji>]`;
 *    the status text is the event CONTENT; both are trimmed; "blank text with
 *    no emoji clears the status … an event carrying neither is what clients
 *    read as 'no status'".
 *  - `desktop/src/shared/api/relayClientSession.ts:382-390` — the desktop
 *    client publishes exactly that shape, and
 *    `desktop/src/features/user-status/hooks.ts:66-70` reads it back with
 *    `{kinds:[30315], authors:[…], "#d":["general"]}`.
 *
 * Expiry: NIP-38 permits the NIP-40 `expiration` tag, and the relay does not
 * enforce it for 30315 (its `extract_expiration` is moderation-only). A
 * replaceable event with no expiry therefore shows forever, so a status
 * carrying one is treated as absent once it passes — honoured on READ. It is
 * deliberately not written: the desktop and CLI would ignore an expiration we
 * published and keep showing the status, so emitting one would create a
 * status that has expired on one client and not another.
 */

/** NIP-38 user status. `crates/buzz-core/src/kind.rs:70`. */
export const KIND_USER_STATUS = 30315;

/**
 * The `d` coordinate Buzz uses for the profile status line.
 * `crates/buzz-sdk/src/builders.rs:1725`.
 */
export const USER_STATUS_D_TAG = "general";

export interface UserStatus {
  /** Status text — the event content. */
  text: string;
  /** Status emoji from the `emoji` tag; "" when none. */
  emoji: string;
  /** The event's `created_at`, unix seconds. */
  updatedAt: number;
  /** NIP-40 `expiration` (unix seconds), or null when unbounded. */
  expiresAt: number | null;
}

/** The subset of a signed event this module reads. */
export interface StatusEventLike {
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

function tagValue(tags: string[][], name: string): string | null {
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return null;
}

/**
 * Tags for a status publish: the `d` coordinate, plus `emoji` when set.
 *
 * Mirrors `build_user_status`: the emoji is trimmed and dropped when blank,
 * so clearing the emoji really removes the tag rather than writing `""`.
 */
export function buildUserStatusTags(emoji: string): string[][] {
  const trimmed = emoji.trim();
  const tags: string[][] = [["d", USER_STATUS_D_TAG]];
  if (trimmed !== "") {
    tags.push(["emoji", trimmed]);
  }
  return tags;
}

/** The unsigned event body for a status publish; "" text + "" emoji clears. */
export function buildUserStatusEvent(
  text: string,
  emoji: string,
): { kind: number; content: string; tags: string[][] } {
  return {
    kind: KIND_USER_STATUS,
    content: text.trim(),
    tags: buildUserStatusTags(emoji),
  };
}

/**
 * Read one kind:30315 event.
 *
 * Returns `status: null` for an event on the wrong `d` coordinate, and for
 * the empty event that Buzz publishes to CLEAR a status — which is the same
 * thing to a reader, because a parameterized-replaceable kind has no delete:
 * an empty event IS the absence of a status.
 */
export function parseUserStatusEvent(event: StatusEventLike): {
  pubkey: string;
  status: UserStatus | null;
} {
  const d = tagValue(event.tags, "d");
  if (d !== USER_STATUS_D_TAG) {
    return { pubkey: event.pubkey, status: null };
  }
  const text = event.content.trim();
  const emoji = (tagValue(event.tags, "emoji") ?? "").trim();
  if (text === "" && emoji === "") {
    return { pubkey: event.pubkey, status: null };
  }
  const rawExpiration = tagValue(event.tags, "expiration");
  const expiresAt =
    rawExpiration !== null && /^\d+$/.test(rawExpiration)
      ? Number.parseInt(rawExpiration, 10)
      : null;
  return {
    pubkey: event.pubkey,
    status: { text, emoji, updatedAt: event.created_at, expiresAt },
  };
}

/** True once a status's `expiration` has passed. */
export function isStatusExpired(
  status: UserStatus,
  nowSeconds: number,
): boolean {
  return status.expiresAt !== null && status.expiresAt <= nowSeconds;
}

/** The status if it is still current, otherwise null. */
export function activeStatus(
  status: UserStatus | null,
  nowSeconds: number,
): UserStatus | null {
  if (status === null || isStatusExpired(status, nowSeconds)) {
    return null;
  }
  return status;
}

/**
 * Fold a stream of status events into one status per author.
 *
 * Newer `created_at` wins, matching NIP-33 replacement — the relay replaces
 * server-side, but a live subscription and a historical replay can still
 * deliver both an old and a new event, in either order.
 */
export function reduceStatusEvents(
  events: readonly StatusEventLike[],
  nowSeconds: number,
): Map<string, UserStatus> {
  const newest = new Map<string, { at: number; status: UserStatus | null }>();
  for (const event of events) {
    const { pubkey, status } = parseUserStatusEvent(event);
    const existing = newest.get(pubkey);
    if (existing && existing.at >= event.created_at) {
      continue;
    }
    newest.set(pubkey, { at: event.created_at, status });
  }
  const result = new Map<string, UserStatus>();
  for (const [pubkey, entry] of newest) {
    const current = activeStatus(entry.status, nowSeconds);
    if (current) {
      result.set(pubkey, current);
    }
  }
  return result;
}

/** One-line rendering: "🏖️ Vacationing", or just the text, or just the emoji. */
export function statusLabel(status: UserStatus): string {
  return [status.emoji, status.text].filter((part) => part !== "").join(" ");
}

/**
 * Follow / unfollow — editing the NIP-02 contact list (kind:3).
 *
 * Kind 3 is **replaceable**, and its whole payload is the `p` tag list. So a
 * follow is not "publish a follow event": it is "republish the entire list
 * with one more entry". That makes the destructive failure mode obvious and
 * the reason this module exists: a naive writer that emits only the pubkey
 * being followed **unfollows everyone else**, silently, with no undo. The same
 * hazard the kind-0 serializer guards against, one kind along and considerably
 * worse.
 *
 * Two consequences, both enforced below:
 *
 * - Every edit starts from the previous event's tags and preserves them
 *   verbatim — including relay hints, petnames, and any tag type this client
 *   does not model.
 * - An edit against a list that has **not been read yet** is refused outright.
 *   "No previous event" and "the read has not finished" are indistinguishable
 *   from an empty list, and guessing wrong wipes the user's follows.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export const KIND_CONTACT_LIST = 3;

export interface ContactListEvent {
  tags: string[][];
  content: string;
  created_at: number;
}

export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

function normalize(pubkey: string): string | null {
  const value = pubkey.trim().toLowerCase();
  return HEX_PUBKEY.test(value) ? value : null;
}

/** The pubkeys a contact list follows, in order, de-duplicated. */
export function followedPubkeys(
  event: ContactListEvent | null | undefined,
): string[] {
  if (!event) {
    return [];
  }
  const seen = new Set<string>();
  const follows: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "p") {
      continue;
    }
    const pubkey = normalize(tag[1] ?? "");
    if (pubkey === null || seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    follows.push(pubkey);
  }
  return follows;
}

export function isFollowing(
  event: ContactListEvent | null | undefined,
  pubkey: string,
): boolean {
  const needle = normalize(pubkey);
  return needle !== null && followedPubkeys(event).includes(needle);
}

export class ContactListNotLoadedError extends Error {
  constructor() {
    super(
      "Your follow list has not loaded yet. Publishing now would replace it with an empty one.",
    );
    this.name = "ContactListNotLoadedError";
  }
}

/**
 * Build the replacement event for a follow or unfollow.
 *
 * `previous` must be the newest kind-3 the client has actually seen, or
 * `null` **only** when the read has finished and found none — the `loaded`
 * flag is what separates that from "still loading", and a false one throws.
 *
 * `content` is carried across untouched: some clients keep an encrypted
 * follow list or relay metadata there, and rewriting it to `""` would destroy
 * data this client cannot even read.
 */
export function buildContactListEvent(input: {
  previous: ContactListEvent | null;
  loaded: boolean;
  pubkey: string;
  follow: boolean;
}): EventTemplate {
  if (!input.loaded) {
    throw new ContactListNotLoadedError();
  }
  const target = normalize(input.pubkey);
  if (target === null) {
    throw new Error("A public key must be 64 hex characters.");
  }
  const previousTags = input.previous?.tags ?? [];
  const withoutTarget = previousTags.filter(
    (tag) => !(tag[0] === "p" && normalize(tag[1] ?? "") === target),
  );
  const tags = input.follow ? [...withoutTarget, ["p", target]] : withoutTarget;
  return {
    kind: KIND_CONTACT_LIST,
    content: input.previous?.content ?? "",
    tags,
  };
}

/** Newest wins; ties keep the incumbent so a re-send is a no-op. */
export function pickLatestContactList(
  current: ContactListEvent | null,
  candidate: ContactListEvent,
): ContactListEvent {
  if (!current) {
    return candidate;
  }
  return candidate.created_at > current.created_at ? candidate : current;
}

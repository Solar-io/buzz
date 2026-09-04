import type { RelaySession } from "@/shared/api/relay-session";
import type {
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "@/shared/lib/nostr-signer";

import {
  likedTargets,
  noteFromEvent,
  orderByLikedAt,
  toFeed,
} from "./noteFeed.ts";
import { foldReactions, UPVOTE_EMOJI } from "./noteReactions.ts";
import { withoutProjectComments } from "./projectComments.ts";
import { queryOnce, type QueryableSession } from "./relayQuery.ts";
import {
  KIND_CONTACT_LIST,
  KIND_DELETION,
  KIND_REACTION,
  KIND_TEXT_NOTE,
  type PulseNote,
  type PulseReactionState,
} from "./pulseTypes.ts";

/**
 * The relay clamps a REQ's `limit` to `buzz_db::DEFAULT_MAX_PAGE_LIMIT`
 * (1000). The desktop's Rust commands cap notes at 200
 * (`get_global_notes`, `get_notes_timeline`), so the web asks for the same:
 * matching the desktop's page size keeps the two feeds comparable, and a
 * bigger number would not return more rows anyway once the relay clamps.
 */
export const NOTE_PAGE_LIMIT = 200;

/** Reactions are fetched several-per-note; this is the whole-page ceiling. */
export const REACTION_PAGE_LIMIT = 1000;

/** `get_notes_timeline` refuses more than this many authors in one filter. */
export const MAX_TIMELINE_AUTHORS = 100;

type PublishableSession = QueryableSession & Pick<RelaySession, "publish">;

/**
 * Signs an event.
 *
 * Injected, with a DYNAMIC import as the default, so this module has no
 * top-level value import behind the `@/` alias — which is what lets
 * `node --test` (no path-alias resolver) exercise these flows against a fake
 * session. Same reason as `features/channels/lib/unreact.ts`.
 */
export type EventSigner = (
  template: Omit<UnsignedNostrEvent, "created_at">,
) => Promise<SignedNostrEvent>;

const defaultSigner: EventSigner = async (template) => {
  const { signNostrEvent } = await import("@/shared/lib/nostr-signer");
  return signNostrEvent(template);
};

/** Notes from everyone — the Everyone tab. Mirrors `get_global_notes`. */
export async function fetchGlobalNotes(
  session: QueryableSession,
  limit = NOTE_PAGE_LIMIT,
): Promise<PulseNote[]> {
  const events = await queryOnce(session, {
    kinds: [KIND_TEXT_NOTE],
    limit,
  });
  return withoutProjectComments(toFeed(events.map(noteFromEvent)));
}

/**
 * Notes from a set of authors — the Following and Agents tabs. Mirrors
 * `get_notes_timeline`: ONE multi-author filter, not one REQ per author.
 *
 * An empty author list returns nothing without touching the relay. A filter
 * with `authors: []` is not "everyone" to a Nostr relay, but it is also not
 * worth a round trip, and sending one is how a "Following" tab quietly turns
 * into a second global feed if a relay ever treats the empty array as absent.
 */
export async function fetchNotesByAuthors(
  session: QueryableSession,
  authors: readonly string[],
  limitPerAuthor = 10,
): Promise<PulseNote[]> {
  if (authors.length === 0) {
    return [];
  }
  const capped = authors.slice(0, MAX_TIMELINE_AUTHORS);
  const events = await queryOnce(session, {
    kinds: [KIND_TEXT_NOTE],
    authors: [...capped],
    limit: Math.min(limitPerAuthor * capped.length, NOTE_PAGE_LIMIT),
  });
  return withoutProjectComments(toFeed(events.map(noteFromEvent)));
}

/** The viewer's own notes — the Mine tab. Mirrors `get_user_notes`. */
export function fetchOwnNotes(
  session: QueryableSession,
  pubkey: string,
  limit = 50,
): Promise<PulseNote[]> {
  return fetchNotesByAuthors(session, [pubkey], limit);
}

/**
 * Notes the viewer has upvoted — the Liked tab. Mirrors `get_liked_notes`:
 * their own `kind:7` reactions, minus the ones a `kind:5` retracted, resolved
 * to the `kind:1` notes they target and ordered by when they were liked.
 */
export async function fetchLikedNotes(
  session: QueryableSession,
  pubkey: string,
  limit = 50,
): Promise<PulseNote[]> {
  const reactions = await queryOnce(session, {
    kinds: [KIND_REACTION],
    authors: [pubkey],
    limit: Math.min(limit * 4, REACTION_PAGE_LIMIT),
  });
  if (reactions.length === 0) {
    return [];
  }
  const deletions = await queryOnce(session, {
    kinds: [KIND_DELETION],
    authors: [pubkey],
    "#e": reactions.map((event) => event.id),
    limit: REACTION_PAGE_LIMIT,
  });
  const { ids, likedAt } = likedTargets(reactions, deletions, limit);
  if (ids.length === 0) {
    return [];
  }
  const notes = await queryOnce(session, {
    kinds: [KIND_TEXT_NOTE],
    ids,
    limit,
  });
  return orderByLikedAt(
    withoutProjectComments(notes.map(noteFromEvent)),
    likedAt,
  );
}

/**
 * Upvote state for the notes currently on screen.
 *
 * Two REQs, not one: the reactions themselves, then the deletions that
 * retract them. Folding without the second query leaves an un-liked note
 * showing a filled heart forever, because NIP-25 has no un-react event — a
 * removal is a `kind:5` naming the reaction.
 */
export async function fetchReactionState(
  session: QueryableSession,
  noteIds: readonly string[],
  currentPubkey: string | null,
): Promise<Map<string, PulseReactionState>> {
  if (noteIds.length === 0) {
    return new Map();
  }
  const reactions = await queryOnce(session, {
    kinds: [KIND_REACTION],
    "#e": [...noteIds],
    limit: REACTION_PAGE_LIMIT,
  });
  if (reactions.length === 0) {
    return new Map();
  }
  const deletions = await queryOnce(session, {
    kinds: [KIND_DELETION],
    "#e": reactions.map((event) => event.id),
    limit: REACTION_PAGE_LIMIT,
  });
  return foldReactions(reactions, deletions, currentPubkey);
}

/** The viewer's NIP-02 contact list — the Following tab's author set. */
export async function fetchContactPubkeys(
  session: QueryableSession,
  pubkey: string,
): Promise<string[]> {
  const events = await queryOnce(session, {
    kinds: [KIND_CONTACT_LIST],
    authors: [pubkey],
    limit: 1,
  });
  // kind:3 is replaceable, so at most one event should come back — but a
  // reconnect replay can deliver an older copy alongside the current one.
  // Newest wins, exactly as NIP-01 replacement says.
  const newest = events.reduce<SignedNostrEvent | null>(
    (best, event) =>
      best === null || event.created_at > best.created_at ? event : best,
    null,
  );
  if (!newest) {
    return [];
  }
  const seen = new Set<string>();
  for (const tag of newest.tags) {
    if (tag[0] === "p" && tag[1]) {
      seen.add(tag[1]);
    }
  }
  return [...seen];
}

export interface PublishResult {
  ok: boolean;
  message: string;
}

/** Publish a new `kind:1` note, optionally as a reply and with `p` mentions. */
export async function publishNote(
  session: PublishableSession,
  options: {
    content: string;
    /** Event id this note replies to; adds the NIP-10 marked `e` tag. */
    replyTo?: string | null;
    mentionPubkeys?: readonly string[];
  },
  signEvent: EventSigner = defaultSigner,
): Promise<PublishResult> {
  const tags: string[][] = [];
  if (options.replyTo) {
    tags.push(["e", options.replyTo, "", "reply"]);
  }
  for (const pubkey of options.mentionPubkeys ?? []) {
    tags.push(["p", pubkey]);
  }
  const event = await signEvent({
    kind: KIND_TEXT_NOTE,
    tags,
    content: options.content,
  });
  return session.publish(event);
}

/** Add the viewer's `+` upvote to a note. */
export async function upvoteNote(
  session: PublishableSession,
  noteId: string,
  signEvent: EventSigner = defaultSigner,
): Promise<PublishResult> {
  const event = await signEvent({
    kind: KIND_REACTION,
    tags: [["e", noteId]],
    content: UPVOTE_EMOJI,
  });
  return session.publish(event);
}

/**
 * Remove the viewer's own upvote.
 *
 * There is no un-react event in NIP-25: the removal is a `kind:5` naming the
 * viewer's own `kind:7` by id, and that id is not held locally (the fold
 * keeps pubkeys, not reaction ids), so it is looked up first. The filter and
 * the deletion template are the channel client's — the relay's ingest rules
 * for a reaction deletion are the same wherever the reaction lives, and
 * restating them here is how the two surfaces would drift apart.
 */
export async function removeUpvote(
  session: PublishableSession,
  noteId: string,
  selfPubkey: string,
  signEvent: EventSigner = defaultSigner,
): Promise<PublishResult> {
  const {
    buildReactionDeleteTemplate,
    ownReactionFilter,
    pickOwnReactionEventId,
  } = await import("@/features/channels/lib/reactions.ts");
  const mine = await queryOnce(session, ownReactionFilter(noteId, selfPubkey));
  const reactionEventId = pickOwnReactionEventId(mine, {
    targetEventId: noteId,
    emoji: UPVOTE_EMOJI,
    selfPubkey,
  });
  if (!reactionEventId) {
    return { ok: false, message: "Could not find your like to remove." };
  }
  const event = await signEvent(buildReactionDeleteTemplate(reactionEventId));
  return session.publish(event);
}

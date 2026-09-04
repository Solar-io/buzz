import type { RelaySession } from "@/shared/api/relay-session";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
// `queryOnce` is imported lazily inside the default query below: a static
// `@/` value import would make this module unloadable under `node --test`,
// which resolves no bundler alias. `unreact.ts` uses the same trick for its
// own default signer.

/**
 * Author names for the readable transcript.
 *
 * The JSON export carries raw pubkeys and needs none of this. The Markdown
 * transcript does: `abcd1234…wxyz` said this is not a transcript anybody
 * wants to read. Names are resolved from the exported events themselves —
 * after the walk, not before — so a channel's whole cast is covered rather
 * than only the members the sidebar happened to have loaded.
 */

/** kind-0 profile metadata. */
const PROFILE_KIND = 0;

/**
 * Authors per REQ. Relays reject unbounded `authors` lists, and a channel
 * with thousands of distinct posters would build one.
 */
export const AUTHOR_BATCH = 200;

/** Timeout per profile batch — shorter than a history page; names are optional. */
const PROFILE_TIMEOUT_MS = 8_000;

/**
 * The display name in a kind-0 event, preferring `display_name` the way the
 * timeline's `useProfiles` does. Returns null when there is nothing usable,
 * so callers fall back to a truncated pubkey rather than an empty label.
 */
export function profileNameFromEvent(event: SignedNostrEvent): string | null {
  if (event.kind !== PROFILE_KIND) {
    return null;
  }
  let parsed: { name?: unknown; display_name?: unknown };
  try {
    parsed = JSON.parse(event.content) as typeof parsed;
  } catch {
    return null;
  }
  const displayName =
    typeof parsed.display_name === "string" ? parsed.display_name.trim() : "";
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const chosen = displayName || name;
  return chosen.length > 0 ? chosen : null;
}

/**
 * Collapse kind-0 events into a pubkey → name map, newest wins.
 *
 * Profiles are replaceable events, so a relay may serve more than one
 * revision for the same author in one page; taking the newest keeps the
 * transcript agreeing with what the app shows.
 */
export function displayNamesFromEvents(
  events: readonly SignedNostrEvent[],
): Map<string, string> {
  const names = new Map<string, string>();
  const at = new Map<string, number>();
  for (const event of events) {
    const name = profileNameFromEvent(event);
    if (name === null) {
      continue;
    }
    const previous = at.get(event.pubkey);
    if (previous !== undefined && previous >= event.created_at) {
      continue;
    }
    at.set(event.pubkey, event.created_at);
    names.set(event.pubkey, name);
  }
  return names;
}

/** Distinct authors of a set of events, in first-seen order. */
export function distinctAuthors(events: readonly SignedNostrEvent[]): string[] {
  const authors: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.pubkey)) {
      continue;
    }
    seen.add(event.pubkey);
    authors.push(event.pubkey);
  }
  return authors;
}

/** Split a list into fixed-size chunks. Never yields an empty chunk. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    return items.length > 0 ? [[...items]] : [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Fetch display names for every author of `events`.
 *
 * Failure is not fatal: an unresolved author renders as a truncated pubkey,
 * which is strictly better than failing an export over cosmetics.
 */
export async function fetchDisplayNames(
  session: Pick<RelaySession, "subscribe">,
  events: readonly SignedNostrEvent[],
  query: (
    session: Pick<RelaySession, "subscribe">,
    authors: string[],
  ) => Promise<SignedNostrEvent[]> = async (target, authors) => {
    const { queryOnce } = await import("@/features/channels/lib/unreact.ts");
    return queryOnce(
      target,
      { kinds: [PROFILE_KIND], authors, limit: authors.length },
      PROFILE_TIMEOUT_MS,
    );
  },
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const authors of chunk(distinctAuthors(events), AUTHOR_BATCH)) {
    try {
      for (const [pubkey, name] of displayNamesFromEvents(
        await query(session, authors),
      )) {
        names.set(pubkey, name);
      }
    } catch {
      // Names are a nicety; keep whatever resolved and move on.
    }
  }
  return names;
}

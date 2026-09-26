/**
 * Last-opened conversation (plan item 5, 2026-09-26).
 *
 * Opening `/repos` with nothing selected used to paint "Pick a channel to get
 * started" and then, after up to 5 s of DM sampling (D-025), redirect to the
 * most recently ACTIVE DM — not the one Sam last used. Now the conversation
 * he last opened is remembered and the route redirects to it before the
 * first paint; D-025 remains the fallback when nothing is stored or the
 * stored one is gone.
 *
 * Keyed by relay URL, not pubkey: the pubkey resolves asynchronously (from
 * IndexedDB) after the first paint, and a client has one owner per relay.
 * The pubkey is recorded alongside once known, so an account switch on the
 * same relay drops the other identity's entry instead of landing in it.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export const LAST_CONVERSATION_PREFIX = "buzz:last-conversation.v1:";

export interface LastConversation {
  channelId: string;
  at: number;
  /** Owner, when it was known at save time. */
  pubkey: string | null;
}

type ReadStorage = Pick<Storage, "getItem"> | null | undefined;
type WriteStorage = Pick<Storage, "setItem" | "removeItem"> | null | undefined;

export function loadLastConversation(
  storage: ReadStorage,
  scope: string,
): LastConversation | null {
  try {
    const raw = storage?.getItem(LAST_CONVERSATION_PREFIX + scope);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<LastConversation>;
    if (typeof parsed.channelId !== "string" || parsed.channelId === "") {
      return null;
    }
    return {
      channelId: parsed.channelId,
      at: typeof parsed.at === "number" ? parsed.at : 0,
      pubkey: typeof parsed.pubkey === "string" ? parsed.pubkey : null,
    };
  } catch {
    return null;
  }
}

export function saveLastConversation(
  storage: WriteStorage,
  scope: string,
  entry: LastConversation,
): void {
  try {
    storage?.setItem(LAST_CONVERSATION_PREFIX + scope, JSON.stringify(entry));
  } catch {
    // Quota/private mode: landing falls back to D-025, nothing breaks.
  }
}

export function clearLastConversation(
  storage: WriteStorage,
  scope: string,
): void {
  try {
    storage?.removeItem(LAST_CONVERSATION_PREFIX + scope);
  } catch {
    // Same as above.
  }
}

/**
 * The route-level redirect: only a bare `/repos` (no `c`, no `view`, no
 * permalink) is redirected, which is also the loop guard — the redirect
 * target carries `c`.
 */
export function landingRedirectTarget(
  search: { c?: string; view?: string; m?: string },
  stored: LastConversation | null,
): string | null {
  if (search.c !== undefined || search.view !== undefined) {
    return null;
  }
  if (search.m !== undefined) {
    return null;
  }
  return stored?.channelId ?? null;
}

export type RestoreVerdict = "valid" | "stale" | "wait";

/**
 * Is a restored conversation still real? Valid as soon as it is in the list
 * (the seeded list usually has it at first render). Stale when it is hidden,
 * belongs to another identity, or is still missing once the list has had its
 * chance to load (connected + DM sampling settled, or the 5 s hard cap).
 */
export function restoreVerdict(inputs: {
  channelId: string;
  storedPubkey: string | null;
  selfPubkey: string | null;
  knownChannelIds: ReadonlySet<string>;
  hiddenDmIds: readonly string[];
  listSettled: boolean;
}): RestoreVerdict {
  const { channelId, storedPubkey, selfPubkey } = inputs;
  if (storedPubkey && selfPubkey && storedPubkey !== selfPubkey) {
    return "stale";
  }
  if (inputs.hiddenDmIds.includes(channelId)) {
    return "stale";
  }
  if (inputs.knownChannelIds.has(channelId)) {
    return "valid";
  }
  return inputs.listSettled ? "stale" : "wait";
}

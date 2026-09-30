import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useCommunityRoster } from "@/features/community-members/hooks";
import {
  parseSearchOperators,
  resolveAuthorOperator,
  resolveChannelOperator,
} from "@/features/search/lib/parseSearchOperators.ts";
import {
  forgetSearch,
  readRecentSearches,
  rememberSearch,
  writeRecentSearches,
} from "@/features/search/lib/recentSearches.ts";
import {
  buildSearchFilter,
  dedupeHits,
  minimumQueryLength,
  searchHitFromEvent,
  sortHits,
  type SearchHit,
} from "@/features/search/lib/searchQuery.ts";
import { searchResultKey } from "@/features/search/lib/searchResults.ts";
import { SearchResultRow } from "@/features/search/ui/SearchResultRow";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";

import type { Profile } from "../hooks.ts";
import { useProfiles } from "../hooks.ts";
import { MESSAGE_SEARCH_KINDS } from "../lib/messageBuffer.ts";
import type { ChannelSummary } from "../useChannels";

/** A REQ carries a finite author list; the roster is sampled, not sent whole. */
const PEOPLE_LOOKUP_CAP = 128;

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * ⌘K's message search: NIP-50 full text with `from:` `in:` `after:`
 * `before:` operators, a "this channel" scope, and recent searches.
 *
 * Moved out of SearchPanel unchanged in behaviour (web redesign Phase 2):
 * the palette now JUMPS first — channels, people, commands, with inline
 * completion — and searches messages when asked to ("Search messages for …")
 * or when the query carries an operator. Keeping the relay search behind that
 * choice also stops ⌘K from firing a full-text REQ for every word typed on
 * the way to a channel name.
 *
 * The owner passes the (debounced) query; this component owns the relay REQ
 * and hands its result list up through `onResults` so the panel's one
 * keyboard handler can walk it.
 */
export function useMessageSearch({
  query,
  channels,
  profiles,
  scopeChannelId,
}: {
  /** Debounced query text, operators included. */
  query: string;
  channels: ChannelSummary[];
  profiles: Map<string, Profile>;
  /** A scope set by the "This channel" chip; wins over `in:`. */
  scopeChannelId: string | null;
}) {
  const { session } = useRelaySession();
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<string[]>(() =>
    readRecentSearches(safeLocalStorage()),
  );

  // People for `from:` — the roster the relay publishes, named by whatever
  // kind-0 this browser already holds. One REQ while the palette is open.
  const roster = useCommunityRoster();
  const rosterPubkeys = useMemo(
    () =>
      roster.members.map((member) => member.pubkey).slice(0, PEOPLE_LOOKUP_CAP),
    [roster.members],
  );
  const rosterProfiles = useProfiles(rosterPubkeys);
  const people = useMemo(() => {
    const merged = new Map<
      string,
      { pubkey: string; displayName: string | null }
    >();
    for (const pubkey of rosterPubkeys) {
      merged.set(pubkey, {
        pubkey,
        displayName: rosterProfiles.get(pubkey)?.displayName ?? null,
      });
    }
    for (const [pubkey, profile] of profiles) {
      const existing = merged.get(pubkey);
      merged.set(pubkey, {
        pubkey,
        displayName: profile.displayName || existing?.displayName || null,
      });
    }
    return [...merged.values()];
  }, [profiles, rosterProfiles, rosterPubkeys]);

  const parsed = useMemo(() => parseSearchOperators(query), [query]);
  const channelResolution = useMemo(
    () =>
      scopeChannelId
        ? ({ status: "resolved", value: scopeChannelId } as const)
        : resolveChannelOperator(parsed.in, channels),
    [scopeChannelId, parsed.in, channels],
  );
  const authorResolution = useMemo(
    () => resolveAuthorOperator(parsed.from, people),
    [parsed.from, people],
  );
  const hasUnresolvedOperator =
    channelResolution.status === "unresolved" ||
    authorResolution.status === "unresolved";
  const activeScopeId =
    channelResolution.status === "resolved" ? channelResolution.value : null;

  const filter = useMemo(
    () =>
      buildSearchFilter({
        parsed,
        kinds: MESSAGE_SEARCH_KINDS,
        channelId: activeScopeId,
        author:
          authorResolution.status === "resolved"
            ? authorResolution.value
            : null,
        hasUnresolvedOperator,
      }),
    [parsed, activeScopeId, authorResolution, hasUnresolvedOperator],
  );
  // The filter object is rebuilt every render; its JSON is its identity.
  const filterKey = filter === null ? "" : JSON.stringify(filter);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `filter` is re-issued by `filterKey`, which is its content identity
  useEffect(() => {
    if (filter === null) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    setHits([]);
    const collected: SearchHit[] = [];
    return session.subscribe(filter, {
      onEvent: (event: SignedNostrEvent) => {
        const hit = searchHitFromEvent(event);
        if (hit) {
          collected.push(hit);
          setHits(sortHits(dedupeHits(collected)));
        }
      },
      onEose: () => setSearching(false),
    });
  }, [session, filterKey]);

  // Remember a query only once it has actually been searched: storing every
  // keystroke would fill the list with prefixes of one search.
  useEffect(() => {
    if (filter === null) {
      return;
    }
    setRecent((current) => {
      const next = rememberSearch(current, parsed.text);
      writeRecentSearches(safeLocalStorage(), next);
      return next;
    });
  }, [filter, parsed.text]);

  const nameFor = (pubkey: string) =>
    profiles.get(pubkey)?.displayName ||
    rosterProfiles.get(pubkey)?.displayName ||
    truncatePubkey(pubkey);
  const pictureFor = (pubkey: string) =>
    profiles.get(pubkey)?.avatar ?? rosterProfiles.get(pubkey)?.avatar;

  return {
    parsed,
    hits,
    searching,
    recent,
    forgetRecent: (entry: string) =>
      setRecent((current) => {
        const next = forgetSearch(current, entry);
        writeRecentSearches(safeLocalStorage(), next);
        return next;
      }),
    activeScopeId,
    scopeLabel: activeScopeId
      ? (channels.find((channel) => channel.id === activeScopeId)?.name ??
        "this channel")
      : null,
    hasUnresolvedOperator,
    unresolvedTerm:
      channelResolution.status === "unresolved"
        ? `in:${parsed.in}`
        : `from:${parsed.from}`,
    minimum: minimumQueryLength(activeScopeId),
    nameFor,
    pictureFor,
  };
}

export type MessageSearchState = ReturnType<typeof useMessageSearch>;

/** The message hits, or the state that explains why there are none. */
export function MessageSearchResults({
  search,
  channels,
  selected,
  onSelect,
  onOpen,
  onPickRecent,
}: {
  search: MessageSearchState;
  channels: ChannelSummary[];
  selected: number;
  onSelect: (index: number) => void;
  onOpen: (hit: SearchHit) => void;
  onPickRecent: (entry: string) => void;
}) {
  if (search.hits.length > 0) {
    return (
      <>
        {search.hits.map((hit, index) => {
          const result = { kind: "message" as const, hit };
          return (
            <SearchResultRow
              authorLabel={search.nameFor}
              authorPicture={search.pictureFor}
              channelName={(channelId) =>
                channels.find((channel) => channel.id === channelId)?.name ??
                ""
              }
              key={searchResultKey(result)}
              onActivate={() => onOpen(hit)}
              onHover={() => onSelect(index)}
              query={search.parsed.text}
              result={result}
              selected={index === selected}
            />
          );
        })}
      </>
    );
  }
  if (search.hasUnresolvedOperator) {
    return (
      <p
        className="px-4 py-3 text-sm text-muted-foreground"
        data-testid="search-unresolved"
      >
        Nothing here is called{" "}
        <code className="text-foreground">{search.unresolvedTerm}</code>. Fix
        the filter or remove it — searching without it would answer a
        different question.
      </p>
    );
  }
  if (search.searching) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">Searching…</p>
    );
  }
  if (search.parsed.text.length >= search.minimum) {
    return (
      <p
        className="px-4 py-3 text-sm text-muted-foreground"
        data-testid="search-no-results"
      >
        No messages match “{search.parsed.text}”.
      </p>
    );
  }
  if (search.recent.length > 0) {
    return (
      <div className="py-1" data-testid="search-recent">
        <p className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Recent searches
        </p>
        {search.recent.map((entry) => (
          <div
            className="flex items-center gap-1 rounded-lg px-1 hover:bg-accent"
            key={entry}
          >
            <button
              className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
              onClick={() => onPickRecent(entry)}
              type="button"
            >
              {entry}
            </button>
            <button
              aria-label={`Forget “${entry}”`}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground"
              onClick={() => search.forgetRecent(entry)}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}
      </div>
    );
  }
  return <OperatorHint minimum={search.minimum} />;
}

/** How to narrow a message search — shown wherever the list has room. */
export function OperatorHint({ minimum }: { minimum?: number }) {
  return (
    <p className="px-4 py-3 text-xs text-muted-foreground">
      {minimum ? `Type at least ${minimum} characters. ` : ""}Narrow a message
      search with <code className="text-foreground">from:</code>,{" "}
      <code className="text-foreground">in:</code>,{" "}
      <code className="text-foreground">after:2025-03-01</code> or{" "}
      <code className="text-foreground">before:2025-03-05</code>.
    </p>
  );
}

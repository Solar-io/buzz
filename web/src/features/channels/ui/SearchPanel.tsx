import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCommunityRoster } from "@/features/community-members/hooks";
import { useProfileActions } from "@/features/profile/ProfileActionsContext";
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
import {
  assembleSearchResults,
  clampSelection,
  moveSelection,
  scoreChannelMatch,
  scorePersonMatch,
  searchResultKey,
  type SearchChannelResult,
  type SearchPersonResult,
  type SearchResult,
} from "@/features/search/lib/searchResults.ts";
import { SearchResultRow } from "@/features/search/ui/SearchResultRow";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

import type { Profile } from "../hooks.ts";
import { useProfiles } from "../hooks.ts";
import { MESSAGE_SEARCH_KINDS } from "../lib/messageBuffer.ts";
import type { QuickCandidate } from "../lib/quickSwitcher.ts";
import type { ChannelSummary } from "../useChannels";

const DEBOUNCE_MS = 300;
/** A REQ carries a finite author list; the roster is sampled, not sent whole. */
const PEOPLE_LOOKUP_CAP = 128;
const MAX_JUMP_RESULTS = 5;

/**
 * The ⌘K palette: jump targets, people, and NIP-50 message search.
 *
 * What this adds over the first version, and why each one is not cosmetic:
 *
 * - **Operators** (`from:` `in:` `after:` `before:`). An operator that matches
 *   nothing refuses to search rather than widening back to everything — see
 *   `buildSearchFilter`.
 * - **Keyboard navigation.** The panel previously had none: every result was
 *   mouse-only, which makes a command palette useless to the people most
 *   likely to open one.
 * - **People.** Resolved from the community roster (kind:13534) plus whoever
 *   the shell has already loaded a profile for. The web client has no
 *   user-directory endpoint, and the roster is the relay-native stand-in.
 * - **A scope chip** rather than a two-button segmented control, so a scope
 *   set by `in:#general` and a scope set by the control look the same and are
 *   removed the same way (click the chip, or Backspace on an empty field).
 * - **Recent searches**, which the desktop has no equivalent of.
 */
export function SearchPanel(props: {
  open: boolean;
  onClose: () => void;
  channels: ChannelSummary[];
  profiles: Map<string, Profile>;
  /** Channel open when the panel was invoked — the "this channel" target. */
  defaultChannelId: string | null;
  onOpenResult: (channelId: string, messageId: string) => void;
  /** Text typed into the sidebar's search field before opening, if any. */
  initialQuery?: string;
  onJumpToChannel: (channelId: string) => void;
  /** Palette actions supplied by the shell ("New channel", "Settings", …). */
  actions?: QuickCandidate[];
}) {
  // Every hook below opens a subscription or a listener; mounting them behind
  // the open flag keeps a closed palette at zero cost.
  if (!props.open) {
    return null;
  }
  return <SearchPanelBody {...props} />;
}

function SearchPanelBody({
  onClose,
  channels,
  profiles,
  defaultChannelId,
  onOpenResult,
  initialQuery,
  onJumpToChannel,
  actions,
}: {
  onClose: () => void;
  channels: ChannelSummary[];
  profiles: Map<string, Profile>;
  defaultChannelId: string | null;
  onOpenResult: (channelId: string, messageId: string) => void;
  initialQuery?: string;
  onJumpToChannel: (channelId: string) => void;
  actions?: QuickCandidate[];
}) {
  const { session } = useRelaySession();
  const shellActions = useProfileActions();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState(initialQuery ?? "");
  const [debounced, setDebounced] = useState(initialQuery ?? "");
  const [scopeChannelId, setScopeChannelId] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const [recent, setRecent] = useState<string[]>(() =>
    readRecentSearches(safeLocalStorage()),
  );

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // People come from the roster the relay publishes, named by whatever kind-0
  // this browser already holds. One REQ while the palette is open.
  const roster = useCommunityRoster();
  const rosterPubkeys = useMemo(
    () =>
      roster.members.map((member) => member.pubkey).slice(0, PEOPLE_LOOKUP_CAP),
    [roster.members],
  );
  const rosterProfiles = useProfiles(rosterPubkeys);

  const nameFor = (pubkey: string) =>
    profiles.get(pubkey)?.displayName ||
    rosterProfiles.get(pubkey)?.displayName ||
    truncatePubkey(pubkey);
  const pictureFor = (pubkey: string) =>
    profiles.get(pubkey)?.avatar ?? rosterProfiles.get(pubkey)?.avatar;

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

  const parsed = useMemo(() => parseSearchOperators(debounced), [debounced]);

  // A scope set by the chip wins over `in:`; otherwise `in:` supplies one.
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
  const scopeLabel = activeScopeId
    ? (channels.find((channel) => channel.id === activeScopeId)?.name ??
      "this channel")
    : null;

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

  const needle = parsed.text;
  const channelResults = useMemo<SearchChannelResult[]>(() => {
    if (activeScopeId) {
      return [];
    }
    return channels
      .flatMap((channel) => {
        const score = scoreChannelMatch(
          { name: channel.name, about: channel.about },
          needle,
        );
        return score === null ? [] : [{ channel, score }];
      })
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.channel.name.localeCompare(right.channel.name),
      )
      .slice(0, MAX_JUMP_RESULTS)
      .map(({ channel }) => ({
        kind: "channel" as const,
        id: channel.id,
        label: channel.name,
        hint: channel.about || undefined,
      }));
  }, [channels, needle, activeScopeId]);

  const personResults = useMemo<SearchPersonResult[]>(() => {
    if (activeScopeId || needle.length < 2) {
      return [];
    }
    return people
      .flatMap((person) => {
        const score = scorePersonMatch(person, needle);
        return score === null ? [] : [{ person, score }];
      })
      .sort((left, right) => left.score - right.score)
      .slice(0, MAX_JUMP_RESULTS)
      .map(({ person }) => ({
        kind: "person" as const,
        pubkey: person.pubkey,
        label: person.displayName || truncatePubkey(person.pubkey),
        hint: "Open a direct message",
      }));
  }, [people, needle, activeScopeId]);

  const actionResults = useMemo(() => {
    const query = needle.trim().toLowerCase();
    if (query.length === 0) {
      return [];
    }
    // Keywords are matched as well as the label, because the shell supplies
    // them precisely so "dm" finds "New message" — filtering on the label
    // alone would silently throw that away.
    return (actions ?? [])
      .filter((action) =>
        [action.label, ...(action.keywords ?? [])].some((haystack) =>
          haystack.toLowerCase().includes(query),
        ),
      )
      .slice(0, MAX_JUMP_RESULTS)
      .map((action) => ({
        kind: "action" as const,
        id: action.id,
        label: action.label,
        hint: action.hint,
      }));
  }, [actions, needle]);

  const results = useMemo(
    () =>
      assembleSearchResults({
        actions: actionResults,
        channels: channelResults,
        people: personResults,
        messages: hits.map((hit) => ({ kind: "message" as const, hit })),
      }),
    [actionResults, channelResults, personResults, hits],
  );

  useEffect(() => {
    setSelected((current) => clampSelection(current, results.length));
  }, [results.length]);

  const activate = (result: SearchResult) => {
    if (result.kind === "message") {
      onOpenResult(result.hit.channelId, result.hit.id);
    } else if (result.kind === "channel") {
      onJumpToChannel(result.id);
    } else if (result.kind === "person") {
      shellActions.onOpenDm?.(result.pubkey);
    } else {
      actions?.find((action) => action.id === result.id)?.onSelect?.();
    }
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) =>
        moveSelection(
          current,
          event.key === "ArrowDown" ? 1 : -1,
          results.length,
        ),
      );
      return;
    }
    if (event.key === "Enter") {
      const target = results[selected];
      if (target) {
        event.preventDefault();
        activate(target);
      }
      return;
    }
    // Backspace on an empty field peels the scope chip off, the way a
    // recipient chip behaves in a compose field.
    if (event.key === "Backspace" && query.length === 0 && scopeChannelId) {
      event.preventDefault();
      setScopeChannelId(null);
    }
  };

  const minimum = minimumQueryLength(activeScopeId);
  const activeId =
    results[selected] !== undefined
      ? `search-result-${searchResultKey(results[selected])}`
      : undefined;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on the input, which holds focus
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-through is the close affordance
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh] backdrop-blur-sm"
      data-testid="search-panel"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click-stop only */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the input */}
      <div
        className="w-[min(92vw,42rem)] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          {scopeLabel ? (
            <button
              aria-label={`Search everywhere instead of #${scopeLabel}`}
              className="flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-2 text-xs"
              data-testid="search-scope-chip"
              onClick={() => setScopeChannelId(null)}
              type="button"
            >
              <span className="truncate">#{scopeLabel}</span>
              <X aria-hidden className="size-3 shrink-0" />
            </button>
          ) : null}
          <input
            aria-activedescendant={activeId}
            aria-controls="search-results"
            aria-expanded
            aria-label={
              scopeLabel ? `Search in ${scopeLabel}` : "Search everything"
            }
            autoCapitalize="none"
            autoCorrect="off"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-base outline-hidden placeholder:text-muted-foreground"
            data-testid="search-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search messages, or jump to a channel · from: in: after: before:"
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            value={query}
          />
          {defaultChannelId && !scopeChannelId ? (
            <button
              className="shrink-0 rounded-md border border-border px-2 py-1 text-2xs text-muted-foreground hover:bg-accent/50"
              data-testid="search-scope-current"
              onClick={() => {
                setScopeChannelId(defaultChannelId);
                inputRef.current?.focus();
              }}
              type="button"
            >
              This channel
            </button>
          ) : null}
          <kbd className="shrink-0 rounded border border-border/70 bg-muted/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
            ESC
          </kbd>
        </div>

        <div
          aria-label="Search results"
          className="buzz-channel-activity-scrollbar max-h-[55vh] overflow-y-auto"
          id="search-results"
          role="listbox"
        >
          {results.map((result, index) => (
            <SearchResultRow
              authorLabel={nameFor}
              authorPicture={pictureFor}
              channelName={(channelId) =>
                channels.find((channel) => channel.id === channelId)?.name ?? ""
              }
              key={searchResultKey(result)}
              onActivate={() => activate(result)}
              onHover={() => setSelected(index)}
              query={needle}
              result={result}
              selected={index === selected}
            />
          ))}

          {results.length === 0 ? (
            <EmptyState
              hasUnresolvedOperator={hasUnresolvedOperator}
              minimum={minimum}
              onPickRecent={(entry) => {
                setQuery(entry);
                setDebounced(entry);
                inputRef.current?.focus();
              }}
              onForgetRecent={(entry) => {
                setRecent((current) => {
                  const next = forgetSearch(current, entry);
                  writeRecentSearches(safeLocalStorage(), next);
                  return next;
                });
              }}
              parsedText={needle}
              recent={recent}
              searching={searching}
              unresolvedTerm={
                channelResolution.status === "unresolved"
                  ? `in:${parsed.in}`
                  : `from:${parsed.from}`
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  hasUnresolvedOperator,
  unresolvedTerm,
  minimum,
  parsedText,
  recent,
  searching,
  onPickRecent,
  onForgetRecent,
}: {
  hasUnresolvedOperator: boolean;
  unresolvedTerm: string;
  minimum: number;
  parsedText: string;
  recent: string[];
  searching: boolean;
  onPickRecent: (entry: string) => void;
  onForgetRecent: (entry: string) => void;
}) {
  if (hasUnresolvedOperator) {
    return (
      <p
        className="px-4 py-3 text-sm text-muted-foreground"
        data-testid="search-unresolved"
      >
        Nothing here is called{" "}
        <code className="text-foreground">{unresolvedTerm}</code>. Fix the
        filter or remove it — searching without it would answer a different
        question.
      </p>
    );
  }
  if (searching) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">Searching…</p>
    );
  }
  if (parsedText.length >= minimum) {
    return (
      <p
        className="px-4 py-3 text-sm text-muted-foreground"
        data-testid="search-no-results"
      >
        No results for “{parsedText}”.
      </p>
    );
  }
  if (recent.length > 0) {
    return (
      <div className="py-1" data-testid="search-recent">
        <p className="px-3 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent
        </p>
        {recent.map((entry) => (
          <div
            className="flex items-center gap-1 px-1 hover:bg-accent/50"
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
              onClick={() => onForgetRecent(entry)}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}
      </div>
    );
  }
  return (
    <p className="px-4 py-3 text-sm text-muted-foreground">
      Type at least {minimum} character{minimum === 1 ? "" : "s"}. Narrow with{" "}
      <code className="text-foreground">from:</code>,{" "}
      <code className="text-foreground">in:</code>,{" "}
      <code className="text-foreground">after:2025-03-01</code> or{" "}
      <code className="text-foreground">before:2025-03-05</code>.
    </p>
  );
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

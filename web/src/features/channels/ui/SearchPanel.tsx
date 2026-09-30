import { ArrowLeft, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useProfileActions } from "@/features/profile/ProfileActionsContext";
import { parseSearchOperators } from "@/features/search/lib/parseSearchOperators.ts";
import {
  clampSelection,
  moveSelection,
} from "@/features/search/lib/searchResults.ts";
import { JumpRow, SearchMessagesRow } from "@/features/search/ui/JumpRow";
import { useVisitScores } from "@/features/sidebar/lib/useSidebarOrder.ts";
import { markerLabel } from "@/features/work/lib/channelMarkers.ts";
import { useWorkCounts } from "@/features/work/useWorkCounts.ts";
import { cn } from "@/shared/lib/cn";

import type { Profile } from "../hooks.ts";
import {
  acceptJumpGhost,
  buildJumpResults,
  JUMP_SCOPES,
  type JumpCandidate,
  parseJumpQuery,
  recentJumpKeys,
  scopedJumpText,
} from "../lib/jump.ts";
import type { QuickCandidate } from "../lib/quickSwitcher.ts";
import type { ChannelSummary } from "../useChannels";
import { channelTopic } from "./ChannelHeader.tsx";
import {
  MessageSearchResults,
  OperatorHint,
  useMessageSearch,
} from "./MessageSearch.tsx";

const DEBOUNCE_MS = 300;

/** A slash command ⌘K can run or hand to the composer (`/remind`, …). */
export interface JumpCommand {
  id: string;
  hint: string;
  onSelect: () => void;
}

type Candidate = JumpCandidate & {
  pubkey?: string;
  isPrivate?: boolean;
  run: () => void;
};

/**
 * The ⌘K palette (web redesign Phase 2; Jump artboard).
 *
 * It JUMPS first. What you type is matched against the channels, people,
 * commands and actions the shell already holds — instantly, no relay round
 * trip — with the rest of the top hit shown as ghost text that Tab accepts.
 * `#` `@` `/` as the first character (or the chips under the field) narrow it
 * to channels, people or commands; with nothing typed it lists where you
 * were last. Full-text MESSAGE search is one row away at the bottom
 * ("Search messages for …"), and a query that uses an operator (`from:`
 * `in:` `after:` `before:`) goes straight to it.
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
  /** Slash commands runnable from here. */
  commands?: JumpCommand[];
  /** A DM's name (its participants); the relay names every DM "DM". */
  dmLabel?: (channel: ChannelSummary) => string;
  selfPubkey?: string | null;
}) {
  // Every hook below opens a subscription or a listener; mounting them behind
  // the open flag keeps a closed palette at zero cost.
  if (!props.open) {
    return null;
  }
  return <SearchPanelBody {...props} />;
}

function hasOperator(text: string): boolean {
  const parsed = parseSearchOperators(text);
  return (
    parsed.from !== null ||
    parsed.in !== null ||
    parsed.since !== null ||
    parsed.until !== null
  );
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
  commands,
  dmLabel,
  selfPubkey,
}: Parameters<typeof SearchPanel>[0]) {
  const shellActions = useProfileActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [debounced, setDebounced] = useState(initialQuery ?? "");
  const [messagesMode, setMessagesMode] = useState(false);
  const [scopeChannelId, setScopeChannelId] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const searchingMessages = messagesMode || hasOperator(query);
  const search = useMessageSearch({
    query: searchingMessages ? debounced : "",
    channels,
    profiles,
    scopeChannelId,
  });

  // ── jump candidates ──────────────────────────────────────────────────────
  const { markers } = useWorkCounts();
  const visits = useVisitScores();
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    const dmPartners = new Set<string>();
    for (const channel of channels) {
      if (channel.archived) {
        continue;
      }
      const marker = markers.get(channel.id);
      const status = markerLabel(marker);
      if (channel.type === "dm") {
        const others = channel.participantPubkeys.filter(
          (pubkey) => pubkey !== selfPubkey,
        );
        if (others.length === 1) {
          dmPartners.add(others[0]);
        }
        out.push({
          key: `conversation:${channel.id}`,
          kind: "dm",
          label: dmLabel?.(channel) ?? channel.name,
          hint: status ?? (others.length > 1 ? "group DM" : undefined),
          hot: (marker?.needs ?? 0) > 0,
          pubkey: others[0],
          run: () => onJumpToChannel(channel.id),
        });
        continue;
      }
      out.push({
        key: `conversation:${channel.id}`,
        kind: "channel",
        label: channel.name,
        hint:
          status ??
          (channel.isPrivate
            ? "private"
            : (channelTopic(channel) ?? undefined)),
        hot: (marker?.needs ?? 0) > 0,
        isPrivate: channel.isPrivate,
        keywords: [channel.name.replace(/[-_]/g, " ")],
        run: () => onJumpToChannel(channel.id),
      });
    }
    for (const [pubkey, profile] of profiles) {
      if (
        pubkey === selfPubkey ||
        dmPartners.has(pubkey) ||
        !profile.displayName
      ) {
        continue;
      }
      out.push({
        key: `person:${pubkey}`,
        kind: "person",
        label: profile.displayName,
        hint: "Open a direct message",
        pubkey,
        run: () => shellActions.onOpenDm?.(pubkey),
      });
    }
    for (const command of commands ?? []) {
      out.push({
        key: `command:${command.id}`,
        kind: "command",
        label: command.id,
        hint: command.hint,
        run: command.onSelect,
      });
    }
    for (const action of actions ?? []) {
      out.push({
        key: action.id,
        kind: "action",
        label: action.label,
        hint: action.hint,
        keywords: action.keywords,
        run: () => action.onSelect?.(),
      });
    }
    return out;
  }, [
    channels,
    markers,
    profiles,
    commands,
    actions,
    selfPubkey,
    dmLabel,
    onJumpToChannel,
    shellActions,
  ]);
  const recents = useMemo(() => recentJumpKeys(visits), [visits]);
  const jumpQuery = parseJumpQuery(query);
  const jump = useMemo(
    () =>
      buildJumpResults({
        query: parseJumpQuery(query),
        candidates,
        recents,
      }),
    [query, candidates, recents],
  );
  const byKey = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.key, candidate])),
    [candidates],
  );
  // The search row trails the jump rows whenever something is typed.
  const offerSearch = jumpQuery.needle !== "" && jumpQuery.scope !== "command";
  const jumpCount = jump.flat.length + (offerSearch ? 1 : 0);
  const count = searchingMessages ? search.hits.length : jumpCount;

  useEffect(() => {
    setSelected((current) => clampSelection(current, count));
  }, [count]);
  // A new query starts at the top hit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` is the trigger
  useEffect(() => {
    setSelected(0);
  }, [query]);

  const startMessageSearch = () => {
    setMessagesMode(true);
    setQuery(jumpQuery.needle);
    setDebounced(jumpQuery.needle);
    inputRef.current?.focus();
  };
  const activateJump = (index: number) => {
    const item = jump.flat[index];
    if (item) {
      byKey.get(item.key)?.run();
      onClose();
      return;
    }
    if (offerSearch && index === jump.flat.length) {
      startMessageSearch();
    }
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
        moveSelection(current, event.key === "ArrowDown" ? 1 : -1, count),
      );
      return;
    }
    if (event.key === "Tab" && !searchingMessages) {
      const accepted = acceptJumpGhost(jumpQuery, jump);
      if (accepted !== null) {
        event.preventDefault();
        setQuery(accepted);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (searchingMessages) {
        const hit = search.hits[selected];
        if (hit) {
          onOpenResult(hit.channelId, hit.id);
          onClose();
        }
        return;
      }
      if (jumpCount === 0 && jumpQuery.needle !== "") {
        startMessageSearch();
        return;
      }
      activateJump(selected);
      return;
    }
    if (event.key === "Backspace" && query.length === 0) {
      // Backspace on an empty field peels the scope chip, then leaves
      // message search — the way a recipient chip behaves in a compose field.
      if (scopeChannelId) {
        event.preventDefault();
        setScopeChannelId(null);
      } else if (messagesMode) {
        event.preventDefault();
        setMessagesMode(false);
      }
    }
  };

  const activeId = searchingMessages
    ? search.hits[selected]
      ? `search-result-message:${search.hits[selected].id}`
      : undefined
    : selected < jump.flat.length
      ? `search-result-${jump.flat[selected]?.key}`
      : offerSearch
        ? "search-result-messages"
        : undefined;
  const ghost = searchingMessages ? "" : jump.ghost;

  let rowIndex = -1;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on the input, which holds focus
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-through is the close affordance
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-[8vh] backdrop-blur-[2px]"
      data-testid="search-panel"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the input */}
      <div
        role="dialog"
        aria-label="Jump to"
        className="flex max-h-[80vh] w-[min(calc(100vw-2rem),40rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-elev"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-14.5 shrink-0 items-center gap-3 border-b border-border px-4.5">
          {messagesMode ? (
            <button
              type="button"
              aria-label="Back to jump"
              onClick={() => {
                setMessagesMode(false);
                inputRef.current?.focus();
              }}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent"
            >
              <ArrowLeft aria-hidden className="size-4" />
            </button>
          ) : (
            <Search
              aria-hidden
              className="size-4.5 shrink-0 text-muted-foreground"
            />
          )}
          {searchingMessages && search.scopeLabel ? (
            <button
              aria-label={`Search everywhere instead of #${search.scopeLabel}`}
              className="flex h-6 max-w-40 shrink-0 items-center gap-1 rounded-md bg-chip px-2 text-xs"
              data-testid="search-scope-chip"
              onClick={() => setScopeChannelId(null)}
              type="button"
            >
              <span className="truncate">#{search.scopeLabel}</span>
              <X aria-hidden className="size-3 shrink-0" />
            </button>
          ) : null}
          <div className="relative h-8 min-w-0 flex-1">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-lg"
            >
              <span className="text-transparent">{query}</span>
              <span data-testid="jump-ghost" className="text-faint">
                {ghost}
              </span>
            </div>
            <input
              aria-activedescendant={activeId}
              aria-controls="search-results"
              aria-expanded
              aria-label={
                searchingMessages
                  ? "Search messages"
                  : "Jump to a channel, person or command"
              }
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              className="absolute inset-0 w-full bg-transparent text-lg outline-hidden placeholder:text-muted-foreground"
              data-testid="search-input"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                searchingMessages
                  ? "Search messages · from: in: after: before:"
                  : "Jump to a channel, person or command"
              }
              ref={inputRef}
              role="combobox"
              spellCheck={false}
              value={query}
            />
          </div>
          {ghost ? (
            <span className="hidden shrink-0 rounded-[5px] bg-chip px-1.5 py-px font-mono text-2xs text-ink-2 sm:inline">
              Tab to complete
            </span>
          ) : null}
          {searchingMessages && defaultChannelId && !scopeChannelId ? (
            <button
              className="shrink-0 rounded-md border border-border px-2 py-1 text-2xs text-muted-foreground hover:bg-accent"
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
          <kbd className="shrink-0 rounded-[5px] border border-line-2 px-[5px] font-mono text-2xs text-muted-foreground">
            esc
          </kbd>
        </div>

        {!searchingMessages && (
          <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3.5 py-2">
            {JUMP_SCOPES.map((scope) => {
              const on = scope.id === jumpQuery.scope;
              return (
                <button
                  key={scope.id}
                  type="button"
                  aria-pressed={on}
                  data-testid={`jump-scope-${scope.id}`}
                  onClick={() => {
                    setQuery(scopedJumpText(scope.id, jumpQuery.needle));
                    inputRef.current?.focus();
                  }}
                  className={cn(
                    "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-[7px] border px-2.5 text-xs font-semibold",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-ink-2 hover:bg-accent",
                  )}
                >
                  {scope.label}
                  {scope.key ? (
                    <span className="font-mono text-2xs opacity-70">
                      {scope.key}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        <div
          aria-label="Results"
          className="buzz-channel-activity-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5"
          id="search-results"
          role="listbox"
        >
          {searchingMessages ? (
            <MessageSearchResults
              search={search}
              channels={channels}
              selected={selected}
              onSelect={setSelected}
              onOpen={(hit) => {
                onOpenResult(hit.channelId, hit.id);
                onClose();
              }}
              onPickRecent={(entry) => {
                setQuery(entry);
                setDebounced(entry);
                inputRef.current?.focus();
              }}
            />
          ) : (
            <>
              {jump.sections.map((section) => (
                <div key={section.header}>
                  <p className="px-2.5 pt-2.5 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {section.header}
                  </p>
                  {section.items.map((item) => {
                    rowIndex += 1;
                    const index = rowIndex;
                    const candidate = byKey.get(item.key) ?? item;
                    return (
                      <JumpRow
                        key={item.key}
                        id={`search-result-${item.key}`}
                        item={candidate}
                        needle={jumpQuery.needle}
                        selected={index === selected}
                        onActivate={() => activateJump(index)}
                        onHover={() => setSelected(index)}
                      />
                    );
                  })}
                </div>
              ))}
              {offerSearch ? (
                <div>
                  <p className="px-2.5 pt-2.5 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Messages
                  </p>
                  <SearchMessagesRow
                    id="search-result-messages"
                    needle={jumpQuery.needle}
                    selected={selected === jump.flat.length}
                    onActivate={startMessageSearch}
                    onHover={() => setSelected(jump.flat.length)}
                  />
                </div>
              ) : null}
              {jump.flat.length === 0 && jumpQuery.needle !== "" ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  Nothing here is called that. Press ↵ to search messages
                  instead.
                </p>
              ) : null}
              {jumpQuery.needle === "" ? <OperatorHint /> : null}
            </>
          )}
        </div>

        <div className="flex h-10 shrink-0 items-center gap-3 border-t border-border bg-sunk px-4 text-xs text-muted-foreground">
          <span className="ml-auto font-mono text-2xs">
            {searchingMessages
              ? "↑↓ move · ↵ open · ⌫ back"
              : "↑↓ move · Tab complete · ↵ open"}
          </span>
        </div>
      </div>
    </div>
  );
}

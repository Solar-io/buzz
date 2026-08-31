import { useEffect, useMemo, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { ChannelSummary } from "../useChannels";
import { AuthorAvatar, authorLabel } from "./ChannelTimeline.tsx";
import type { Profile } from "../hooks.ts";
import {
  excerpt,
  searchFilter,
  searchHitFromEvent,
  sortHits,
  type SearchHit,
  type SearchScope,
} from "../lib/search.ts";

/**
 * Spotlight-style NIP-50 search over the channel header / ⌘K. One-shot REQ
 * per debounced query; results are newest-first and jump to the message via
 * the permalink (?c=&m=) machinery.
 */
export function SearchPanel({
  open,
  onClose,
  channels,
  profiles,
  defaultChannelId,
  onOpenResult,
}: {
  open: boolean;
  onClose: () => void;
  channels: ChannelSummary[];
  profiles: Map<string, Profile>;
  /** Channel open when the panel was invoked — the scope default. */
  defaultChannelId: string | null;
  onOpenResult: (channelId: string, messageId: string) => void;
}) {
  const { session } = useRelaySession();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // Reset per invocation so reopening starts a fresh search.
      setQuery("");
      setDebounced("");
      setHits([]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  // One-shot search REQ per debounced query. The subscription is torn down on
  // every change (search REQs are one-shot server-side; resubscribing is the
  // only way to issue the next query).
  useEffect(() => {
    const filter = searchFilter(debounced, scope, defaultChannelId);
    if (!filter || !open) {
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
          setHits(sortHits(collected));
        }
      },
      onEose: () => setSearching(false),
    });
  }, [session, debounced, scope, defaultChannelId, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const channelName = useMemo(() => {
    const map = new Map(channels.map((c) => [c.id, c]));
    return (id: string) => map.get(id)?.name ?? "";
  }, [channels]);

  if (!open) {
    return null;
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc handling is registered on window above
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-through is the close affordance; Esc covers keyboard
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh] backdrop-blur-sm"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click-stop only; the interactive elements are inside */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close via Esc on window */}
      <div
        className="w-[min(92vw,40rem)] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span aria-hidden className="text-muted-foreground">
            🔍
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="flex-1 bg-transparent py-1.5 text-base outline-hidden placeholder:text-muted-foreground"
            placeholder="Search messages…"
            aria-label="Search messages"
          />
          <div className="flex overflow-hidden rounded-md border border-border text-xs">
            <button
              type="button"
              className={
                scope === "all"
                  ? "bg-accent px-2 py-1 font-medium"
                  : "px-2 py-1 text-muted-foreground hover:bg-accent/50"
              }
              onClick={() => setScope("all")}
            >
              All channels
            </button>
            <button
              type="button"
              disabled={!defaultChannelId}
              className={
                scope === "channel"
                  ? "bg-accent px-2 py-1 font-medium disabled:opacity-40"
                  : "px-2 py-1 text-muted-foreground hover:bg-accent/50 disabled:opacity-40"
              }
              onClick={() => setScope("channel")}
            >
              This channel
            </button>
          </div>
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {searching && hits.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              Searching…
            </p>
          )}
          {!searching && debounced.trim().length >= 2 && hits.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No results for “{debounced.trim()}”.
            </p>
          )}
          {debounced.trim().length < 2 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              Type at least two characters — the relay full-text-searches every
              channel you can read.
            </p>
          )}
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              className="flex w-full items-start gap-3 border-b border-border/50 px-3 py-2 text-left hover:bg-accent/50"
              onClick={() => {
                onOpenResult(hit.channelId, hit.id);
                onClose();
              }}
            >
              <AuthorAvatar
                pubkey={hit.authorPubkey}
                label={authorLabel(hit.authorPubkey, profiles)}
                picture={profiles.get(hit.authorPubkey)?.avatar}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-semibold">
                    {authorLabel(hit.authorPubkey, profiles)}
                  </span>
                  {channelName(hit.channelId) && (
                    <span className="truncate text-xs text-muted-foreground">
                      # {channelName(hit.channelId)}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                  {excerpt(hit.content, debounced)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

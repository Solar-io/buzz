import { Command, Hash, User } from "lucide-react";
import { useEffect, useRef } from "react";

import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { cn } from "@/shared/lib/cn";

import { searchResultPreview } from "../lib/searchMatch.ts";
import type { SearchResult } from "../lib/searchResults.ts";
import { searchResultKey } from "../lib/searchResults.ts";
import { HighlightedText } from "./HighlightedText.tsx";

/**
 * One row of the palette.
 *
 * The whole list is a single `role="listbox"` with one `aria-selected` option,
 * and the input keeps focus — so the row is a button that is *never* focused,
 * and selection is communicated by `aria-activedescendant` from the input.
 * Moving DOM focus into the list on every arrow key would take the caret out
 * of the field the user is still typing into.
 */
export function SearchResultRow({
  result,
  query,
  selected,
  channelName,
  authorLabel,
  authorPicture,
  onActivate,
  onHover,
}: {
  result: SearchResult;
  query: string;
  selected: boolean;
  /** Resolve a channel id to its name, for message rows. */
  channelName: (channelId: string) => string;
  /** Resolve a pubkey to a display name, for message rows. */
  authorLabel: (pubkey: string) => string;
  authorPicture: (pubkey: string) => string | undefined;
  onActivate: () => void;
  onHover: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  const id = `search-result-${searchResultKey(result)}`;

  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-2 text-left",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
      data-testid={id}
      id={id}
      onClick={onActivate}
      onMouseMove={onHover}
      ref={ref}
      role="option"
      // Keeps the caret in the search field: mousedown would blur it first.
      tabIndex={-1}
      type="button"
    >
      <RowIcon
        authorPicture={authorPicture}
        authorLabel={authorLabel}
        result={result}
      />
      <span className="min-w-0 flex-1">
        <RowBody
          authorLabel={authorLabel}
          channelName={channelName}
          query={query}
          result={result}
        />
      </span>
    </button>
  );
}

function RowIcon({
  result,
  authorLabel,
  authorPicture,
}: {
  result: SearchResult;
  authorLabel: (pubkey: string) => string;
  authorPicture: (pubkey: string) => string | undefined;
}) {
  if (result.kind === "action") {
    return (
      <Command aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
    );
  }
  if (result.kind === "channel") {
    return <Hash aria-hidden className="mt-0.5 size-4 text-muted-foreground" />;
  }
  if (result.kind === "person") {
    return (
      <ProfileAvatar
        className="size-6 text-3xs"
        label={result.label}
        picture={authorPicture(result.pubkey)}
      />
    );
  }
  return (
    <ProfileAvatar
      className="size-6 text-3xs"
      label={authorLabel(result.hit.authorPubkey)}
      picture={authorPicture(result.hit.authorPubkey)}
    />
  );
}

function RowBody({
  result,
  query,
  channelName,
  authorLabel,
}: {
  result: SearchResult;
  query: string;
  channelName: (channelId: string) => string;
  authorLabel: (pubkey: string) => string;
}) {
  if (result.kind === "message") {
    const channel = channelName(result.hit.channelId);
    return (
      <>
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold">
            {authorLabel(result.hit.authorPubkey)}
          </span>
          {channel ? (
            <span className="truncate text-2xs text-muted-foreground">
              #{channel}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground/70">
            {new Date(result.hit.createdAt * 1000).toLocaleDateString()}
          </span>
        </span>
        <HighlightedText
          className="mt-0.5 block truncate text-sm text-muted-foreground"
          query={query}
          text={searchResultPreview(result.hit.content, query)}
        />
      </>
    );
  }

  const label = result.label;
  const hint = result.hint;
  return (
    <span className="flex items-baseline gap-2">
      <HighlightedText
        className="min-w-0 truncate text-sm"
        query={query}
        text={result.kind === "channel" ? `#${label}` : label}
      />
      {hint ? (
        <span className="ml-auto hidden max-w-[55%] shrink truncate text-2xs text-muted-foreground sm:block">
          {hint}
        </span>
      ) : null}
      {result.kind === "person" ? (
        <User
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60"
        />
      ) : null}
    </span>
  );
}

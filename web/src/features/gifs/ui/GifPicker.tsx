import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "@/shared/ui/input";
import { Skeleton } from "@/shared/ui/skeleton";
import { usePrefersReducedMotion } from "../hooks.ts";
import { searchGifs } from "../lib/relay.ts";
import type { KlipyGif } from "../lib/klipy.ts";

/**
 * The GIF tab: trending on open, search as you type, click to insert.
 *
 * One page of results and no "load more" — the relay hardcodes
 * `page=1&per_page=24` and its request struct has no page field
 * (`crates/buzz-relay/src/api/gifs.rs:245`), so 24 is every result a client
 * can obtain. Adding paging is a relay change, not a web one; until then the
 * grid says so rather than pretending the list is exhausted.
 */

const LOADING_TILES = [
  "tall-a",
  "short-a",
  "short-b",
  "tall-b",
  "short-c",
  "short-d",
  "tall-c",
  "short-e",
] as const;

export function GifPicker({
  searchPath,
  onSelect,
  provider,
}: {
  /** Relay-advertised search path (`/gifs/search`). */
  searchPath: string;
  onSelect: (gif: KlipyGif) => void;
  /** Provider name from NIP-11, for the attribution line. */
  provider: string;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const reducedMotion = usePrefersReducedMotion();

  // Every keystroke is a signed NIP-98 request against a rate-limited relay
  // endpoint (`gif_searches_per_min`), so the query has to settle first.
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(search.trim()), 400);
    return () => window.clearTimeout(timeout);
  }, [search]);

  const gifs = useQuery({
    queryKey: ["gif-search", searchPath, debounced],
    queryFn: ({ signal }) => searchGifs(searchPath, debounced, signal),
    retry: false,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="gif-picker">
      <div className="p-2">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search GIFs"
            data-testid="gif-search-input"
            className="h-9 pl-8 pr-8"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search GIFs"
            type="search"
            value={search}
          />
          {gifs.isFetching ? (
            <LoaderCircle
              aria-hidden
              className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
            />
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {gifs.isPending ? (
          <div className="grid grid-cols-2 gap-1.5">
            <span className="sr-only">Loading GIFs</span>
            {LOADING_TILES.map((id) => (
              <Skeleton
                key={id}
                className={id.startsWith("tall") ? "h-24" : "h-16"}
              />
            ))}
          </div>
        ) : gifs.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm text-muted-foreground">
              {gifs.error instanceof Error
                ? gifs.error.message
                : "GIF search failed."}
            </p>
            <button
              type="button"
              className="text-sm font-medium text-primary hover:underline"
              onClick={() => void gifs.refetch()}
            >
              Try again
            </button>
          </div>
        ) : gifs.data.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No GIFs found.
          </p>
        ) : (
          <div className="columns-2 gap-1.5" data-testid="gif-grid">
            {gifs.data.map((gif) => {
              const tile = reducedMotion ? gif.poster : gif.preview;
              return (
                <button
                  key={gif.slug}
                  type="button"
                  aria-label={`Insert ${gif.title}`}
                  title={gif.title}
                  className="mb-1.5 block w-full break-inside-avoid overflow-hidden rounded-lg bg-muted transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onSelect(gif)}
                >
                  {tile ? (
                    <img
                      alt={gif.title}
                      className="block h-auto w-full"
                      height={tile.height}
                      loading="lazy"
                      src={tile.url}
                      width={tile.width}
                    />
                  ) : (
                    // Reduced motion, and KLIPY published no static poster for
                    // this GIF: name it rather than animate it.
                    <span className="flex aspect-video w-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
                      {gif.title}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <p className="border-t border-border/60 px-3 py-1.5 text-center text-xs text-muted-foreground">
        Powered by {provider}
      </p>
    </div>
  );
}

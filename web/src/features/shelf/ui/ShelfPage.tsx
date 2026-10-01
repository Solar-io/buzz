import { Search } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ChannelSummary } from "@/features/channels/useChannels";
import { cn } from "@/shared/lib/cn";
import { Skeleton } from "@/shared/ui/skeleton";
import { useFileTabs } from "../FileTabsProvider";
import { fileOnScreen } from "../lib/fileTabs.ts";
import { openFileOf } from "../lib/shareEvent.ts";
import {
  channelOptions,
  DEFAULT_SHELF_FILTERS,
  filterShares,
  groupByDay,
  senderOptions,
  type ShelfFilters,
  whenLabel,
} from "../lib/shelfView.ts";
import { useShelf } from "../ShelfProvider";
import { useShareNames } from "../useShareNames.ts";
import { SHELF_COLUMNS, ShelfRow, type ShelfLayout } from "./ShelfRow";
import { ShelfToolbar } from "./ShelfToolbar";

const MEDIUM_MIN_PX = 520;
const WIDE_MIN_PX = 680;
/** Rows drawn before "Show more". */
const PAGE = 80;

function useLayout(ref: RefObject<HTMLElement | null>): ShelfLayout {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width >= WIDE_MIN_PX
    ? "wide"
    : width >= MEDIUM_MIN_PX
      ? "medium"
      : "narrow";
}

function useNowSeconds(intervalMs: number): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The Shelf (`?view=shelf`; Shelf artboard): every file shared in a
 * conversation the viewer is in, newest first, grouped by day — type chips,
 * From and In, a search, and a row per share that opens its file beside the
 * list (a full-screen sheet on a phone).
 */
export function ShelfPage({
  channels,
}: {
  channels: readonly ChannelSummary[];
}) {
  const shelf = useShelf();
  const tabs = useFileTabs();
  const shares = shelf?.shares;
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useLayout(rootRef);
  const narrow = layout === "narrow";
  const nowS = useNowSeconds(60_000);
  const [filters, setFilters] = useState<ShelfFilters>(DEFAULT_SHELF_FILTERS);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [limit, setLimit] = useState(PAGE);

  const authors = useMemo(() => senderOptions(shares ?? []), [shares]);
  const names = useShareNames(authors);
  const channelIds = useMemo(() => {
    const known = new Set(channels.map((channel) => channel.id));
    return channelOptions(shares ?? []).filter((id) => known.has(id));
  }, [shares, channels]);

  // Looking at the Shelf is what clears the sidebar's "N new".
  const markSeen = shelf?.markSeen;
  useEffect(() => {
    markSeen?.();
  }, [markSeen]);

  const result = useMemo(
    () =>
      filterShares(shares ?? [], filters, {
        selfPubkey: names.selfPubkey,
        channelName: names.channel,
        personName: names.person,
      }),
    [shares, filters, names],
  );
  const shown = result.rows.slice(0, limit);
  const groups = groupByDay(shown, nowS);
  const change = (next: Partial<ShelfFilters>) => {
    setFilters((previous) => ({ ...previous, ...next }));
    setLimit(PAGE);
  };
  const filtered =
    filters.category !== "all" ||
    filters.sender !== "anyone" ||
    filters.channel !== "anywhere" ||
    filters.text.trim() !== "";

  const search = (
    <label
      className={cn(
        "flex h-8 items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 text-muted-foreground",
        narrow ? "w-full" : "w-56",
      )}
    >
      <Search aria-hidden className="size-3.5 shrink-0" />
      <input
        value={filters.text}
        onChange={(event) => change({ text: event.target.value })}
        aria-label="Search the shelf"
        data-testid="shelf-search"
        placeholder="Search files"
        className="w-full bg-transparent text-sidebar-meta text-foreground outline-hidden placeholder:text-muted-foreground"
      />
    </label>
  );

  return (
    <div
      ref={rootRef}
      data-testid="shelf-page"
      data-layout={layout}
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      {narrow ? (
        <header className="flex flex-col gap-2.5 px-4 pt-4.5 pb-2">
          <h1 className="text-3xl font-bold tracking-tight">Shelf</h1>
          {search}
        </header>
      ) : (
        <header className="flex min-h-14.5 items-center gap-3 border-b border-border px-5 py-2.5">
          <h1 className="text-lg font-bold tracking-tight">Shelf</h1>
          <p className="hidden truncate text-xs text-muted-foreground md:block">
            <span aria-hidden className="mr-2 text-line-2">
              |
            </span>
            Every file shared in a conversation
          </p>
          <span className="ml-auto">{search}</span>
        </header>
      )}
      <ShelfToolbar
        narrow={narrow}
        filters={filters}
        counts={result.counts}
        senders={authors}
        channels={channelIds}
        personName={names.person}
        channelName={names.channel}
        onChange={change}
      />
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          narrow ? "px-4 pb-24" : "px-5 pb-16",
        )}
      >
        {!narrow ? (
          <div
            aria-hidden
            className={cn(
              "sticky top-0 z-10 grid h-8.5 items-center border-b border-border bg-background text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground",
              SHELF_COLUMNS[layout],
            )}
          >
            <span>File</span>
            <span>From</span>
            {layout === "wide" ? <span>Shared in</span> : null}
            <span className="text-right">When</span>
          </div>
        ) : null}
        {!shelf?.loaded && (shares?.length ?? 0) === 0 ? (
          <div data-testid="shelf-loading" className="flex flex-col gap-3 pt-4">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="flex items-center gap-2.5">
                <Skeleton className="size-7 rounded-[7px]" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-48" />
                  <Skeleton className="h-3 w-72 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : result.rows.length === 0 ? (
          <div
            data-testid="shelf-empty"
            className="mx-auto flex max-w-sm flex-col items-center gap-2 py-16 text-center"
          >
            {filtered ? (
              <>
                <p className="text-sm font-semibold">No files match.</p>
                <button
                  type="button"
                  onClick={() => change(DEFAULT_SHELF_FILTERS)}
                  className="text-xs font-semibold text-info-ink hover:underline"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold">
                  Nothing on the Shelf yet.
                </p>
                <p className="text-xs text-muted-foreground">
                  When an agent shares a report, a page or an image with{" "}
                  <code className="font-mono">buzz share</code>, it lands here
                  with a preview, and replies to it become comments.
                </p>
              </>
            )}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h2 className="pt-3 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {group.label}
              </h2>
              {group.rows.map((row) => (
                <ShelfRow
                  key={row.share.id}
                  row={row}
                  layout={layout}
                  names={names}
                  when={whenLabel(row.share.createdAt, nowS)}
                  selectedKey={tabs ? fileOnScreen(tabs.state) : null}
                  expanded={expanded.has(row.share.id)}
                  onToggle={() =>
                    setExpanded((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(row.share.id)) {
                        next.add(row.share.id);
                      }
                      return next;
                    })
                  }
                  onOpen={(file) => tabs?.open(openFileOf(row.share, file))}
                />
              ))}
            </section>
          ))
        )}
        {result.rows.length > limit ? (
          <button
            type="button"
            onClick={() => setLimit((value) => value + PAGE)}
            className="mt-3 h-8 w-full rounded-lg border border-border bg-card text-xs font-semibold text-ink-2 hover:text-foreground"
          >
            Show {Math.min(PAGE, result.rows.length - limit)} more
          </button>
        ) : null}
      </div>
    </div>
  );
}

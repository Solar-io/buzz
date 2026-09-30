import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { useProfiles } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { ScratchActions } from "@/features/commands/lib/commands.ts";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { scratchInfo } from "@/features/scratch/lib/scratchChannel.ts";
import { useNowSeconds } from "@/features/work/useWorkFeed.ts";
import { useWorkContext } from "@/features/work/workContext.ts";
import { cn } from "@/shared/lib/cn";
import { useItems } from "../ItemsProvider";
import { type ItemHead, type ItemPatch, itemKey } from "../lib/itemEvent.ts";
import { scratchNameFor } from "../lib/itemMessages.ts";
import {
  DEFAULT_FILTERS,
  filterItems,
  type ItemFilters,
  type ItemNames,
  itemHaystack,
  ownerOptions,
  projectOptions,
  sortItems,
} from "../lib/itemsView.ts";
import { useItemActions } from "../useItemActions.ts";
import { useItemSources } from "../useItemData.ts";
import { AddItemDialog } from "./AddItemDialog";
import { BulkBar } from "./BulkBar";
import { HandOffDialog } from "./HandOffDialog";
import { COLUMNS, ItemRow } from "./ItemRow";
import type { ItemRowContext, ItemsLayout } from "./itemRowContext.ts";
import { ItemsToolbar } from "./ItemsToolbar";

/** Rows drawn before "Show more": a page, not the whole backlog at once. */
const PAGE = 60;
const MEDIUM_MIN_PX = 672; // @2xl
const WIDE_MIN_PX = 1024; // @5xl

function useLayout(ref: React.RefObject<HTMLElement | null>): ItemsLayout {
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

/**
 * The Items page (`?view=items`; Items artboard): every bug and backlog item
 * the viewer can see, from every channel, newest first — tabs, filters, the
 * table (a list on a phone), an inline expansion to work an item, and a
 * selection bar.
 */
export function ItemsPage({
  channels,
  scratch,
  onOpenMessage,
}: {
  channels: readonly ChannelSummary[];
  /** The shell's scratch actions; absent, "Open a scratch channel" is off. */
  scratch?: ScratchActions;
  onOpenMessage: (channelId: string, messageId?: string) => void;
}) {
  const store = useItems();
  const work = useWorkContext();
  const actions = useItemActions();
  const selfPubkey = work?.selfPubkey ?? null;
  const agentSet = work?.agentPubkeys;
  const items = store?.items;
  const sorted = useMemo(() => sortItems(items ?? []), [items]);
  const nowS = useNowSeconds(60_000);
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useLayout(rootRef);

  // ---- names: channels, DMs, people ---------------------------------------
  const channelById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  );
  const pubkeys = useMemo(() => {
    const set = new Set<string>();
    for (const item of sorted) {
      set.add(item.reporter);
      set.add(item.updatedBy);
      if (item.owner) {
        set.add(item.owner);
      }
      const channel = item.channelId ? channelById.get(item.channelId) : null;
      if (channel?.type === "dm") {
        for (const pubkey of channel.participantPubkeys) {
          set.add(pubkey);
        }
      }
    }
    return [...set];
  }, [sorted, channelById]);
  const profiles = useProfiles(pubkeys);
  const names = useMemo<ItemNames>(
    () => ({
      selfPubkey,
      personName: (pubkey) => authorLabel(pubkey, profiles),
      channelName: (channelId) => {
        const channel = channelId ? channelById.get(channelId) : null;
        if (!channel) {
          return "";
        }
        if (channel.type === "dm") {
          return `DM ${dmDisplayName(channel.participantPubkeys, selfPubkey ?? "", profiles)}`;
        }
        const info = scratchInfo(channel, channels);
        return info
          ? `#${info.label.parent}/${info.label.rest}`
          : `#${channel.name}`;
      },
    }),
    [selfPubkey, profiles, channelById, channels],
  );
  const haystacks = useMemo(() => {
    const map = new Map<ItemHead, string>();
    for (const item of sorted) {
      map.set(item, itemHaystack(item, names));
    }
    return map;
  }, [sorted, names]);

  // ---- filters, paging, expansion, selection ------------------------------
  const [filters, setFilters] = useState<ItemFilters>(DEFAULT_FILTERS);
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [handOff, setHandOff] = useState<readonly ItemHead[] | null>(null);
  const [adding, setAdding] = useState(false);
  const result = useMemo(
    () =>
      filterItems(sorted, filters, names, (item) => haystacks.get(item) ?? ""),
    [sorted, filters, names, haystacks],
  );
  const changeFilters = (next: Partial<ItemFilters>) => {
    setFilters((previous) => ({ ...previous, ...next }));
    setLimit(PAGE);
  };
  const shownRows = result.rows.slice(0, limit);

  // ---- a link to one item (?view=items&item=<d>) ----------------------------
  const target = useSearch({ strict: false, select: (s) => s.item }) as
    | string
    | undefined;
  const navigate = useNavigate();
  useEffect(() => {
    if (!target || !store?.loaded) {
      return;
    }
    const item = sorted.find((candidate) => candidate.id === target);
    if (!item) {
      return;
    }
    const key = itemKey(item.channelId, item.id);
    setFilters({ ...DEFAULT_FILTERS, status: "all" });
    const index = sorted.findIndex(
      (candidate) => itemKey(candidate.channelId, candidate.id) === key,
    );
    setLimit(Math.max(PAGE, index + 1));
    setExpanded(key);
    void navigate({
      to: "/repos",
      search: { view: "items" },
      replace: true,
    });
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-testid="item-row-${item.id}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  }, [target, store?.loaded, sorted, navigate]);

  // ---- actions ---------------------------------------------------------------
  const setBusyFor = useCallback((keys: string[], on: boolean) => {
    setBusy((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  }, []);
  const update = useCallback(
    async (item: ItemHead, patch: ItemPatch) => {
      const key = itemKey(item.channelId, item.id);
      setBusyFor([key], true);
      const published = await actions.update(item, patch);
      setBusyFor([key], false);
      if (!published.ok) {
        toast.error("The item was not changed", {
          description: published.message || "The relay refused the edit.",
        });
      }
    },
    [actions, setBusyFor],
  );
  const openScratch = useCallback(
    async (item: ItemHead) => {
      const channel = item.channelId ? channelById.get(item.channelId) : null;
      if (!scratch || !channel) {
        return;
      }
      const info = scratchInfo(channel, channels);
      const parent = info
        ? { id: info.parentId, name: info.parentName }
        : { id: channel.id, name: channel.name };
      const key = itemKey(item.channelId, item.id);
      setBusyFor([key], true);
      const created = await scratch.create({
        parent,
        name: scratchNameFor(item),
      });
      setBusyFor([key], false);
      if (!created.ok) {
        toast.error("No scratch channel was opened", {
          description: created.error,
        });
        return;
      }
      if (created.notice) {
        toast.success(created.notice);
      }
      if (created.channelId) {
        const posted = await actions.kickoff(created.channelId, item);
        if (!posted.ok) {
          toast.error(
            "The scratch channel is open, but the item was not posted",
            {
              description: posted.message,
            },
          );
        }
      }
    },
    [scratch, channelById, channels, actions, setBusyFor],
  );

  const ctx = useMemo<ItemRowContext>(
    () => ({
      layout,
      nowS,
      selfPubkey,
      channelName: names.channelName,
      isStream: (channelId) =>
        channelId !== null && channelById.get(channelId)?.type === "stream",
      personName: names.personName,
      isAgent: (pubkey) => agentSet?.has(pubkey.toLowerCase()) ?? false,
      participants: (channelId) =>
        channelById.get(channelId)?.participantPubkeys ?? [],
      knownAgents: [...(agentSet ?? [])],
      sources: new Map(),
      busy,
      scratchAvailable: scratch !== undefined,
      onToggleExpand: (item) => {
        const key = itemKey(item.channelId, item.id);
        setExpanded((previous) => (previous === key ? null : key));
      },
      onToggleSelect: (item) => {
        const key = itemKey(item.channelId, item.id);
        setSelected((previous) => {
          const next = new Set(previous);
          if (!next.delete(key)) {
            next.add(key);
          }
          return next;
        });
      },
      onUpdate: (item, patch) => void update(item, patch),
      onHandOff: (list) => setHandOff(list),
      onOpenScratch: (item) => void openScratch(item),
      onOpenMessage,
    }),
    [
      layout,
      nowS,
      selfPubkey,
      names,
      channelById,
      agentSet,
      busy,
      scratch,
      update,
      openScratch,
      onOpenMessage,
    ],
  );
  // Source messages for the rows on screen (captured-from, summary fallback).
  const sourceIds = useMemo(
    () =>
      shownRows
        .map((item) => item.sourceEventId)
        .filter((id): id is string => id !== null),
    [shownRows],
  );
  const sources = useItemSources(sourceIds);
  const rowCtx = useMemo(() => ({ ...ctx, sources }), [ctx, sources]);

  const selectedItems = useMemo(
    () =>
      sorted.filter((item) => selected.has(itemKey(item.channelId, item.id))),
    [sorted, selected],
  );
  const bulk = async (
    label: string,
    patchOf: (item: ItemHead) => ItemPatch | null,
  ) => {
    const keys = selectedItems.map((item) => itemKey(item.channelId, item.id));
    setBusyFor(keys, true);
    const { changed, failures } = await actions.updateEach(
      selectedItems,
      patchOf,
    );
    setBusyFor(keys, false);
    if (failures.length > 0) {
      toast.error(`${failures.length} not ${label}`, {
        description: failures.join("\n"),
      });
    } else if (changed > 0) {
      toast.success(`${changed} ${changed === 1 ? "item" : "items"} ${label}`);
    }
    setSelected(new Set());
  };

  const narrow = layout === "narrow";
  const total = result.tabCounts[filters.tab];
  const allCount = items?.length ?? 0;
  const projects = useMemo(() => projectOptions(sorted), [sorted]);
  const owners = useMemo(() => ownerOptions(sorted), [sorted]);
  const pickableChannels = useMemo(
    () =>
      channels
        .filter((channel) => channel.type !== "dm" && !channel.archived)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  );

  const search = (
    <label
      className={cn(
        "flex h-8 items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 text-muted-foreground",
        narrow ? "w-full" : "w-60",
      )}
    >
      <Search aria-hidden className="size-3.5 shrink-0" />
      <input
        value={filters.text}
        onChange={(event) => changeFilters({ text: event.target.value })}
        aria-label="Filter items"
        data-testid="items-filter-text"
        placeholder="Filter by text, #channel, @agent"
        className="w-full bg-transparent text-sidebar-meta text-foreground outline-hidden placeholder:text-muted-foreground"
      />
    </label>
  );
  const addButton = (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
    >
      <Plus aria-hidden className="size-3.5" />
      {narrow ? "Add" : "Add item"}
    </button>
  );

  return (
    <div
      ref={rootRef}
      data-testid="items-page"
      data-layout={layout}
      className="relative flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      {narrow ? (
        <header className="flex flex-col gap-2.5 px-4 pt-4.5 pb-2">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Items</h1>
            <span className="ml-auto">{addButton}</span>
          </div>
          {search}
        </header>
      ) : (
        <header className="flex min-h-14.5 items-center gap-3 border-b border-border px-6 py-2.5">
          <h1 className="text-lg font-bold tracking-tight">Items</h1>
          {layout === "wide" ? (
            <p className="truncate text-xs text-muted-foreground">
              <span aria-hidden className="mr-2 text-line-2">
                |
              </span>
              Bugs and backlog from every channel. You, or any agent, can file
              one.
            </p>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {search}
            {addButton}
          </div>
        </header>
      )}
      <ItemsToolbar
        layout={layout}
        filters={filters}
        tabCounts={result.tabCounts}
        shown={shownRows.length}
        total={total}
        projects={projects}
        owners={owners}
        personName={names.personName}
        onChange={changeFilters}
      />
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          narrow ? "px-3 pb-24" : "px-6 pb-28",
        )}
      >
        {!narrow ? (
          <div
            aria-hidden
            className={cn(
              "sticky top-0 z-10 grid h-8.5 items-center border-b border-border bg-background text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground",
              COLUMNS[layout === "wide" ? "wide" : "medium"],
            )}
          >
            <span />
            <span>Type</span>
            <span>Item</span>
            {layout === "wide" ? <span>Project</span> : null}
            <span>Source channel</span>
            {layout === "wide" ? <span>Source</span> : null}
            <span>Owner</span>
            <span>Status</span>
            <span className="text-right">Age</span>
          </div>
        ) : null}
        {!store?.loaded && allCount === 0 ? (
          <p className="px-1 py-6 text-sm text-muted-foreground">
            Loading items…
          </p>
        ) : allCount === 0 ? (
          <div className="max-w-md px-1 py-8">
            <p className="text-sm font-semibold">No bugs or backlog yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Type <span className="font-mono">/bug</span> or{" "}
              <span className="font-mono">/backlog</span> in any channel, or ask
              an agent to file one with{" "}
              <span className="font-mono">buzz items add</span>.
            </p>
          </div>
        ) : result.rows.length === 0 ? (
          <div className="px-1 py-8">
            <p className="text-sm text-muted-foreground">
              Nothing matches these filters.
            </p>
            <button
              type="button"
              onClick={() => changeFilters(DEFAULT_FILTERS)}
              className="mt-2 text-sm font-semibold text-info-ink hover:text-foreground"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <ul data-testid="items-list" aria-label="Items">
            {shownRows.map((item) => {
              const key = itemKey(item.channelId, item.id);
              return (
                <ItemRow
                  key={key}
                  item={item}
                  expanded={expanded === key}
                  selected={selected.has(key)}
                  ctx={rowCtx}
                />
              );
            })}
          </ul>
        )}
        {result.rows.length > shownRows.length ? (
          <button
            type="button"
            onClick={() => setLimit((previous) => previous + PAGE)}
            className="my-3 h-8 rounded-lg border border-border px-3 text-xs font-semibold text-ink-2 hover:bg-accent"
          >
            Show {Math.min(PAGE, result.rows.length - shownRows.length)} more
          </button>
        ) : null}
      </div>
      {selectedItems.length > 0 ? (
        <BulkBar
          count={selectedItems.length}
          narrow={narrow}
          busy={selectedItems.some((item) =>
            busy.has(itemKey(item.channelId, item.id)),
          )}
          canHandOff={selectedItems.some((item) => item.channelId !== null)}
          onHandOff={() => setHandOff(selectedItems)}
          onSetType={(type) =>
            void bulk(
              type === "bug" ? "made bugs" : "moved to backlog",
              (item) => (item.type === type ? null : { type }),
            )
          }
          onMarkDone={() =>
            void bulk("marked done", (item) =>
              item.status === "done" ? null : { status: "done" },
            )
          }
          onClear={() => setSelected(new Set())}
        />
      ) : null}
      <HandOffDialog
        items={handOff}
        ctx={rowCtx}
        onClose={() => setHandOff(null)}
        onConfirm={async (input) => {
          const keys = input.items.map((item) =>
            itemKey(item.channelId, item.id),
          );
          setBusyFor(keys, true);
          const { failures } = await actions.handOff(input);
          setBusyFor(keys, false);
          if (failures.length > 0) {
            toast.error("Not everything was handed off", {
              description: failures.join("\n"),
            });
            return false;
          }
          toast.success(
            `Handed ${input.items.length === 1 ? "to" : `${input.items.length} items to`} ${input.seat.name}`,
          );
          setSelected(new Set());
          return true;
        }}
      />
      <AddItemDialog
        open={adding}
        channels={pickableChannels}
        projects={projects.names}
        onClose={() => setAdding(false)}
        onCreate={async (input) => {
          const created = await actions.create(input);
          return created.ok
            ? null
            : created.message || "The relay refused the item.";
        }}
      />
    </div>
  );
}

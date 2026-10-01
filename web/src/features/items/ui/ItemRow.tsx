import { memo } from "react";

import { cn } from "@/shared/lib/cn";
import { shortAge } from "@/features/work/ui/workLabels.ts";
import { type ItemHead, shortItemId } from "../lib/itemEvent.ts";
import { projectLabel } from "../lib/itemsView.ts";
import { useItemSummary } from "../useItemData.ts";
import { AiTag, PersonMark, StatusMark, TypePill } from "./ItemBits";
import { ItemDetail } from "./ItemDetail";
import type { ItemRowContext, ItemsLayout } from "./itemRowContext.ts";
import { OwnerMenu } from "./OwnerMenu";

/**
 * The table's column templates (Items artboard). Wide is the artboard's nine
 * columns; medium (the Work rail open beside it) drops Project and Source;
 * narrow is not a table at all — see {@link ItemCard}.
 */
export const COLUMNS: Record<Exclude<ItemsLayout, "narrow">, string> = {
  wide: "grid-cols-[2rem_4.625rem_minmax(0,1fr)_5.75rem_9.375rem_8rem_8.75rem_6rem_2.5rem]",
  medium: "grid-cols-[2rem_4.625rem_minmax(0,1fr)_8.5rem_8.25rem_6rem_2.5rem]",
};

function SelectBox({
  item,
  selected,
  ctx,
}: {
  item: ItemHead;
  selected: boolean;
  ctx: ItemRowContext;
}) {
  return (
    <input
      type="checkbox"
      checked={selected}
      onChange={() => ctx.onToggleSelect(item)}
      aria-label={`Select ${item.title}`}
      className="size-3.75 cursor-pointer accent-foreground"
    />
  );
}

function SummaryText({
  item,
  ctx,
  className,
}: {
  item: ItemHead;
  ctx: ItemRowContext;
  className?: string;
}) {
  const source =
    item.sourceEventId !== null
      ? (ctx.sources.get(item.sourceEventId) ?? null)
      : null;
  const line = useItemSummary(item, source, ctx.isAgent(item.reporter));
  if (!line) {
    return null;
  }
  return (
    <span
      data-testid="item-summary"
      className={cn("text-xs text-muted-foreground", className)}
    >
      {line.ai ? <AiTag /> : null}
      {line.text}
    </span>
  );
}

/** One row of the table (wide and medium layouts), plus its expansion. */
function ItemTableRow({
  item,
  expanded,
  selected,
  ctx,
}: {
  item: ItemHead;
  expanded: boolean;
  selected: boolean;
  ctx: ItemRowContext;
}) {
  const wide = ctx.layout === "wide";
  return (
    <li
      data-testid={`item-row-${item.id}`}
      className={cn(
        "border-b border-border",
        expanded ? "bg-sunk" : selected ? "bg-accent/50" : undefined,
      )}
    >
      <div
        className={cn(
          "grid min-h-12.5 items-center text-sidebar-meta",
          COLUMNS[wide ? "wide" : "medium"],
        )}
      >
        <span>
          <SelectBox item={item} selected={selected} ctx={ctx} />
        </span>
        <span>
          <TypePill type={item.type} />
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="item-expand"
          onClick={() => ctx.onToggleExpand(item)}
          className="flex min-w-0 flex-col items-start gap-px py-1.5 pr-3.5 text-left"
        >
          <span className="max-w-full truncate text-sm font-semibold">
            {item.title}
          </span>
          <SummaryText item={item} ctx={ctx} className="max-w-full truncate" />
        </button>
        {wide ? (
          <span className="truncate pr-2 text-ink-2">
            {projectLabel(item) ?? ""}
          </span>
        ) : null}
        <span className="truncate pr-2 font-mono text-xs text-ink-2">
          {ctx.channelName(item.channelId)}
        </span>
        {wide ? (
          <span className="flex min-w-0 pr-2">
            <PersonMark
              pubkey={item.reporter}
              name={ctx.personName(item.reporter)}
              agent={ctx.isAgent(item.reporter)}
            />
          </span>
        ) : null}
        <span className="flex min-w-0 pr-2">
          <OwnerMenu item={item} ctx={ctx} />
        </span>
        <span>
          <StatusMark status={item.status} />
        </span>
        <span
          className="text-right font-mono text-2xs text-muted-foreground"
          title={new Date(item.created * 1000).toLocaleString()}
        >
          {shortAge(item.created, ctx.nowS)}
        </span>
      </div>
      {expanded ? <ItemDetail item={item} ctx={ctx} /> : null}
    </li>
  );
}

/**
 * The phone list row (narrow layout): not a squeezed table — a card that
 * reads top to bottom. Type, status and age on one line; the title; the
 * summary; then where it came from and who has it.
 */
function ItemCard({
  item,
  expanded,
  selected,
  ctx,
}: {
  item: ItemHead;
  expanded: boolean;
  selected: boolean;
  ctx: ItemRowContext;
}) {
  const channel = ctx.channelName(item.channelId);
  const project = projectLabel(item);
  return (
    <li
      data-testid={`item-row-${item.id}`}
      className={cn(
        "border-b border-border",
        expanded ? "bg-sunk" : selected ? "bg-accent/50" : undefined,
      )}
    >
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] py-3 pr-1">
        {/* The whole left strip is the hit area: a 15 px box is too small a
            target for a thumb. */}
        <label className="-my-3 flex cursor-pointer items-start justify-center pt-4.5">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => ctx.onToggleSelect(item)}
            aria-label={`Select ${item.title}`}
            className="size-3.75 cursor-pointer accent-foreground"
          />
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <TypePill type={item.type} />
            <StatusMark status={item.status} />
            <span className="ml-auto font-mono text-2xs text-muted-foreground">
              {shortItemId(item.id)} · {shortAge(item.created, ctx.nowS)}
            </span>
          </div>
          <button
            type="button"
            aria-expanded={expanded}
            data-testid="item-expand"
            onClick={() => ctx.onToggleExpand(item)}
            className="flex min-w-0 flex-col items-start gap-0.5 text-left"
          >
            <span className="line-clamp-2 text-sm font-semibold leading-snug">
              {item.title}
            </span>
            <SummaryText item={item} ctx={ctx} className="line-clamp-2" />
          </button>
          <div className="flex min-w-0 items-center gap-2 text-xs text-ink-2">
            {channel || project ? (
              <span className="min-w-0 truncate font-mono text-2xs">
                {[channel, project].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            <span className="ml-auto flex min-w-0 shrink-0">
              <OwnerMenu item={item} ctx={ctx} compact />
            </span>
          </div>
        </div>
      </div>
      {expanded ? <ItemDetail item={item} ctx={ctx} /> : null}
    </li>
  );
}

/**
 * One item, drawn for the page's width. Memoized: the page re-renders on
 * every keystroke in the filter box, and a row whose inputs did not change
 * (the context object is rebuilt only when ITS inputs change) is skipped.
 */
export const ItemRow = memo(function ItemRow(props: {
  item: ItemHead;
  expanded: boolean;
  selected: boolean;
  ctx: ItemRowContext;
}) {
  return props.ctx.layout === "narrow" ? (
    <ItemCard {...props} />
  ) : (
    <ItemTableRow {...props} />
  );
});

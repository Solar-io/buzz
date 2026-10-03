import { ArrowRight, Hash } from "lucide-react";
import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";

import { plainText } from "@/shared/lib/plainText";
import { cn } from "@/shared/lib/cn";
import { clockLabel, shortAge } from "@/features/work/ui/workLabels.ts";
import { type ItemHead, itemKey, shortItemId } from "../lib/itemEvent.ts";
import { itemRowTag } from "../lib/itemMessages.ts";
import { SectionLabel } from "./ItemBits";
import type { ItemRowContext } from "./itemRowContext.ts";
const NO_MENTIONS: ReadonlySet<string> = new Set();

/** "3:34 PM" today, "Mon 10:05 AM" this week, else the date. */
function whenLabel(atS: number, nowS: number): string {
  const age = nowS - atS;
  if (age < 18 * 3600) {
    return clockLabel(atS);
  }
  const date = new Date(atS * 1000);
  if (age < 6 * 86_400) {
    return `${date.toLocaleDateString([], { weekday: "short" })} ${clockLabel(atS)}`;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Where the item has been — the row already shows its status and owner, so
 * this says what the row cannot: its id, who filed it and when, and the
 * latest change. "No owner yet" stays, as the nudge it is.
 */
export function activityLine(item: ItemHead, ctx: ItemRowContext): string {
  // shortAge says "now" for the freshest items, which takes no "ago".
  const ago = (at: number) => {
    const age = shortAge(at, ctx.nowS);
    return age === "now" ? "just now" : `${age} ago`;
  };
  const parts = [
    shortItemId(item.id),
    `filed by ${ctx.personName(item.reporter)} ${ago(item.created)}`,
  ];
  if (item.updatedAt > item.created + 60) {
    parts.push(
      `changed ${ago(item.updatedAt)} by ${ctx.personName(item.updatedBy)}`,
    );
  }
  if (!item.owner) {
    parts.push("no owner yet");
  }
  return parts.join(" · ");
}

/**
 * An expanded row (Items artboard): what it was captured from — the source
 * message, or the item's own notes — on the left; "Work it" on the right.
 */
export function ItemDetail({
  item,
  ctx,
}: {
  item: ItemHead;
  ctx: ItemRowContext;
}) {
  const source =
    item.sourceEventId !== null
      ? (ctx.sources.get(item.sourceEventId) ?? null)
      : null;
  // A /bug confirmation row only restates the title: quote the notes instead.
  const quotable = source && itemRowTag(source.tags) === null ? source : null;
  const quote = quotable ? plainText(quotable.content) : "";
  const notes = item.body;
  const busy = ctx.busy.has(itemKey(item.channelId, item.id));
  const channel = ctx.channelName(item.channelId);
  const canHandOff = item.channelId !== null;
  const canScratch = ctx.scratchAvailable && ctx.isStream(item.channelId);
  const narrow = ctx.layout === "narrow";
  return (
    <div
      data-testid="item-detail"
      className={cn(
        "grid gap-5 pb-4",
        narrow
          ? "grid-cols-1 pt-1 pl-8"
          : "grid-cols-[minmax(0,1fr)_17.5rem] pt-1 pl-26.5",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {quote !== "" && quotable ? (
          <>
            <SectionLabel>Captured from</SectionLabel>
            <div className="rounded-[10px] border border-border bg-card px-3 py-2.5 text-sidebar-meta leading-normal">
              <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <b className="font-semibold">
                  {ctx.personName(quotable.pubkey)}
                </b>
                <span className="font-mono text-2xs text-muted-foreground">
                  {[channel, whenLabel(quotable.created_at, ctx.nowS)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {item.channelId ? (
                  <button
                    type="button"
                    onClick={() =>
                      ctx.onOpenMessage(item.channelId as string, quotable.id)
                    }
                    className="ml-auto text-xs font-semibold text-info-ink hover:text-foreground"
                  >
                    Open in channel ↗
                  </button>
                ) : null}
              </div>
              <p className="line-clamp-5 whitespace-pre-line break-words">
                {quote}
              </p>
            </div>
          </>
        ) : item.sourceEventId && item.channelId && notes === "" ? (
          <button
            type="button"
            onClick={() =>
              ctx.onOpenMessage(
                item.channelId as string,
                item.sourceEventId ?? undefined,
              )
            }
            className="self-start text-xs font-semibold text-info-ink hover:text-foreground"
          >
            Open where it was filed ↗
          </button>
        ) : null}
        {notes !== "" ? (
          <>
            <SectionLabel>Notes</SectionLabel>
            <div className="rounded-[10px] border border-border bg-card px-3 py-2.5 text-sidebar-meta leading-normal break-words">
              <MarkdownContent
                content={notes}
                mentionNames={NO_MENTIONS}
                compact
              />
            </div>
          </>
        ) : null}
        <div
          data-testid="item-activity"
          className="font-mono text-2xs text-muted-foreground"
        >
          {activityLine(item, ctx)}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <SectionLabel>Work it</SectionLabel>
        <button
          type="button"
          disabled={busy || !canHandOff}
          title={
            canHandOff
              ? undefined
              : "Filed without a channel — there is nowhere to post a handoff"
          }
          onClick={() => ctx.onHandOff([item])}
          className="inline-flex h-8.5 items-center justify-center gap-1.75 rounded-lg border border-primary bg-primary text-sidebar-meta font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowRight aria-hidden className="size-3.5" />
          Hand to an agent…
        </button>
        <button
          type="button"
          disabled={busy || !canScratch}
          title={
            canScratch
              ? undefined
              : "Scratch channels copy a channel — this item was not filed from one"
          }
          onClick={() => ctx.onOpenScratch(item)}
          className="inline-flex h-8.5 items-center justify-center gap-1.75 rounded-lg border border-line-2 bg-card text-sidebar-meta font-semibold hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Hash aria-hidden className="size-3.5" strokeDasharray="3 2.4" />
          Open a scratch channel for it
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              ctx.onUpdate(item, {
                status: item.status === "done" ? "open" : "done",
              })
            }
            className="h-7.5 flex-1 rounded-lg border border-border text-xs font-semibold text-ink-2 hover:bg-accent disabled:opacity-50"
          >
            {item.status === "done" ? "Reopen" : "Mark done"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              ctx.onUpdate(item, {
                type: item.type === "bug" ? "backlog" : "bug",
              })
            }
            className="h-7.5 flex-1 rounded-lg border border-border text-xs font-semibold text-ink-2 hover:bg-accent disabled:opacity-50"
          >
            {item.type === "bug" ? "Move to backlog" : "Make it a bug"}
          </button>
        </div>
      </div>
    </div>
  );
}

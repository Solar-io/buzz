/**
 * The chat messages Items posts: the `/bug` · `/backlog` confirmation row,
 * the "Hand to an agent" handoff, and the first message of a scratch channel
 * opened for an item.
 *
 * Each message's CONTENT is the plain-text rendering every other client (and
 * every agent reading the channel) sees, so it carries the full item id —
 * `buzz items get <id>` works from it. The tags are what the web draws from.
 *
 * Import-free (type imports only), so `node --test` loads it.
 */

import {
  isValidItemId,
  itemCoordinate,
  type ItemHead,
  type ItemType,
} from "./itemEvent.ts";

/** `["item", <d>, <type>]` — marks a confirmation row. */
export const ITEM_ROW_TAG = "item";

/** The tag the handoff message carries (`/handoff`'s own, Phase 2). */
export const HANDOFF_TAG = "handoff";

export interface MessageTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

/** `Filed bug 7f3k2m9qa1bc: …` / `Added to backlog 7f3k2m9qa1bc: …`. */
export function confirmationContent(
  type: ItemType,
  d: string,
  title: string,
): string {
  return type === "bug"
    ? `Filed bug ${d}: ${title}`
    : `Added to backlog ${d}: ${title}`;
}

/**
 * The row a `/bug` or `/backlog` posts in the channel it was typed in. The
 * `a` tag is the standard NIP-01 reference to the author's head; the `item`
 * tag is what makes the web draw it as a compact row rather than as text.
 */
export function confirmationTemplate(input: {
  channelId: string;
  author: string;
  d: string;
  type: ItemType;
  title: string;
}): MessageTemplate {
  return {
    kind: 9,
    tags: [
      ["h", input.channelId],
      ["a", itemCoordinate(input.author, input.d)],
      [ITEM_ROW_TAG, input.d, input.type],
    ],
    content: confirmationContent(input.type, input.d, input.title),
  };
}

/** A confirmation row's `["item", d, type]`, or null (absent or malformed). */
export function itemRowTag(
  tags: readonly (readonly string[])[],
): { d: string; type: ItemType } | null {
  const tag = tags.find((candidate) => candidate[0] === ITEM_ROW_TAG);
  const d = tag?.[1];
  const type = tag?.[2];
  if (!d || !isValidItemId(d) || (type !== "bug" && type !== "backlog")) {
    return null;
  }
  return { d, type };
}

/** The title a confirmation row's content carries (for another client's echo). */
export function confirmationTitle(content: string, d: string): string {
  const marker = `${d}: `;
  const at = content.indexOf(marker);
  return at === -1 ? content : content.slice(at + marker.length);
}

function itemLine(item: Pick<ItemHead, "type" | "id" | "title">): string {
  return `${item.type} ${item.id}: ${item.title}`;
}

/**
 * The handoff an item's "Hand to an agent…" posts in its source channel: the
 * `/handoff` shape (content `@Seat …`, the seat's `p`, `["handoff", seat]`),
 * so it draws as the same HANDOFF bar, plus an `a` per item.
 */
export function handoffTemplate(input: {
  channelId: string;
  seat: { pubkey: string; name: string };
  items: readonly Pick<ItemHead, "type" | "id" | "title" | "updatedBy">[];
  note: string;
}): MessageTemplate {
  const lead = `@${input.seat.name}`;
  const body =
    input.items.length === 1
      ? `${lead} please take ${itemLine(input.items[0])}`
      : `${lead} please take these ${input.items.length} items:\n${input.items
          .map((item) => `- ${itemLine(item)}`)
          .join("\n")}`;
  const note = input.note.trim();
  return {
    kind: 9,
    tags: [
      ["h", input.channelId],
      ["p", input.seat.pubkey],
      [HANDOFF_TAG, input.seat.pubkey],
      ...input.items.map((item) => [
        "a",
        itemCoordinate(item.updatedBy, item.id),
      ]),
    ],
    content: note === "" ? body : `${body}\n\n${note}`,
  };
}

/** The first message in a scratch channel opened for an item. */
export function scratchKickoffTemplate(input: {
  channelId: string;
  item: Pick<ItemHead, "type" | "id" | "title" | "summary" | "updatedBy">;
}): MessageTemplate {
  const { item } = input;
  const summary = item.summary?.trim();
  return {
    kind: 9,
    tags: [
      ["h", input.channelId],
      ["a", itemCoordinate(item.updatedBy, item.id)],
    ],
    content: `Scratch channel for ${itemLine(item)}${summary ? `\n\n${summary}` : ""}`,
  };
}

/** The scratch channel's name for an item: `bug-7f3k2`. */
export function scratchNameFor(item: Pick<ItemHead, "type" | "id">): string {
  return `${item.type}-${item.id.slice(0, 5)}`;
}

import { useNavigate } from "@tanstack/react-router";
import { ListPlus } from "lucide-react";

import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { useItems } from "../ItemsProvider";
import { type ItemType, itemKey, shortItemId } from "../lib/itemEvent.ts";
import { confirmationTitle } from "../lib/itemMessages.ts";
import { projectLabel } from "../lib/itemsView.ts";
import { StatusMark } from "./ItemBits";

/**
 * The compact row a `/bug` or `/backlog` posts (Commands artboard): what was
 * filed, where it stands NOW — read from the live fold, so a row posted last
 * week says "Done · Acid Burn" once it is — and a way to open it on the
 * Items page. The message content stays the plain-text rendering other
 * clients show ("Filed bug 7f3k2m9qa1bc: …").
 */
export function ItemRowMessage({
  channelId,
  content,
  itemRef,
  profiles,
}: {
  channelId: string;
  content: string;
  itemRef: { d: string; type: ItemType };
  profiles: Map<string, Profile>;
}) {
  const navigate = useNavigate();
  const item = useItems()?.byKey.get(itemKey(channelId, itemRef.d)) ?? null;
  const type = item?.type ?? itemRef.type;
  const title = item?.title ?? confirmationTitle(content, itemRef.d);
  const project = item ? projectLabel(item) : null;
  const owner = item?.owner ? authorLabel(item.owner, profiles) : "no owner";
  return (
    <div
      data-testid="item-confirmation"
      className="mt-1 flex max-w-2xl flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] border border-leaf-line bg-leaf-soft/45 px-3 py-2 text-sidebar-meta"
    >
      <ListPlus aria-hidden className="size-3.75 shrink-0 text-leaf-ink" />
      <span className="min-w-0 flex-1 basis-56">
        {type === "bug" ? "Filed a " : "Added to the "}
        {project ? <b className="font-semibold">{project} </b> : null}
        {type === "bug" ? "bug" : "backlog"}: “{title}”
      </span>
      <span
        data-testid="item-confirmation-state"
        className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-2xs text-muted-foreground"
      >
        {item ? (
          <>
            <StatusMark status={item.status} />· {owner}
          </>
        ) : (
          `item ${shortItemId(itemRef.d)}`
        )}
      </span>
      <button
        type="button"
        onClick={() =>
          void navigate({
            to: "/repos",
            search: { view: "items", item: itemRef.d },
          })
        }
        className="shrink-0 text-xs font-semibold text-info-ink hover:text-foreground"
      >
        View ↗
      </button>
    </div>
  );
}

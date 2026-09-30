import type { ItemHead, ItemPatch } from "../lib/itemEvent.ts";
import type { ItemSource } from "../lib/itemSummary.ts";

/** Which table the Items page draws at its current width. */
export type ItemsLayout = "wide" | "medium" | "narrow";

/**
 * Everything a row needs from the page, in one object so 150 rows do not
 * each take fifteen props. The page rebuilds it when one of its inputs
 * changes, never per row.
 */
export interface ItemRowContext {
  layout: ItemsLayout;
  nowS: number;
  selfPubkey: string | null;
  /** "#flight-path", "#flight-path/scratch-1", "DM Gilfoyle", or "". */
  channelName: (channelId: string | null) => string;
  /** Is it a stream (the only kind a scratch channel can copy)? */
  isStream: (channelId: string | null) => boolean;
  personName: (pubkey: string) => string;
  isAgent: (pubkey: string) => boolean;
  /** A DM's participants (a DM carries them on its 39000, not a 39002). */
  participants: (channelId: string) => readonly string[];
  /** Every agent the shell knows — the pickers for a channel-less item. */
  knownAgents: readonly string[];
  sources: ReadonlyMap<string, ItemSource>;
  /** Items (by `itemKey`) with a publish in flight. */
  busy: ReadonlySet<string>;
  /** A scratch channel can be opened here at all (the shell supplied it). */
  scratchAvailable: boolean;
  onToggleExpand: (item: ItemHead) => void;
  onToggleSelect: (item: ItemHead) => void;
  onUpdate: (item: ItemHead, patch: ItemPatch) => void;
  onHandOff: (items: readonly ItemHead[]) => void;
  onOpenScratch: (item: ItemHead) => void;
  onOpenMessage: (channelId: string, messageId?: string) => void;
}

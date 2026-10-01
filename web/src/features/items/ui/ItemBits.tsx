import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  HexAvatar,
  type HexRing,
  HumanAvatar,
  StateHex,
} from "@/shared/ui/HexAvatar";
import type { ItemStatus, ItemType } from "../lib/itemEvent.ts";
import { STATUS_LABEL } from "../lib/itemsView.ts";

/** Bug (coral) or Backlog (neutral) — the Type column's pill. */
export function TypePill({
  type,
  className,
}: {
  type: ItemType;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 font-mono text-badge font-semibold",
        type === "bug" ? "bg-coral-soft text-coral-ink" : "bg-chip text-ink-2",
        className,
      )}
    >
      {type === "bug" ? "Bug" : "Backlog"}
    </span>
  );
}

/** The Status column: a hex for work and need, a ring for open, a check for done. */
export function StatusMark({
  status,
  className,
}: {
  status: ItemStatus;
  className?: string;
}) {
  const tone =
    status === "progress"
      ? "text-honey-ink"
      : status === "needs-you"
        ? "text-coral-ink"
        : status === "done"
          ? "text-leaf-ink"
          : "text-muted-foreground";
  return (
    <span
      data-testid="item-status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-2xs font-semibold",
        tone,
        className,
      )}
    >
      {status === "progress" ? (
        <StateHex tone="work" size={8} />
      ) : status === "needs-you" ? (
        <StateHex tone="need" size={8} />
      ) : status === "done" ? (
        <Check aria-hidden className="size-3" strokeWidth={2.5} />
      ) : (
        <span
          aria-hidden
          className="size-2 rounded-full border-[1.5px] border-faint"
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The outer hex says what the owner is doing with THIS item. */
export function ringFor(status: ItemStatus): HexRing {
  return status === "progress"
    ? "work"
    : status === "needs-you"
      ? "need"
      : "idle";
}

/** An agent's hex or a person's circle, then the name. */
export function PersonMark({
  pubkey,
  name,
  agent,
  ring = "idle",
  size = 16,
  className,
}: {
  pubkey: string;
  name: string;
  agent: boolean;
  ring?: HexRing;
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.75", className)}>
      {agent ? (
        <HexAvatar label={name} seed={pubkey} size={size} ring={ring} />
      ) : (
        <HumanAvatar label={name} size={size + 2} />
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Marks machine-written text (an agent's summary, the bridge's summary). */
export function AiTag() {
  return (
    <span
      title="Written by an AI"
      className="mr-1.25 shrink-0 rounded-[3px] bg-chip px-1 font-mono text-badge font-semibold text-muted-foreground"
    >
      AI
    </span>
  );
}

/** Small caps section label ("CAPTURED FROM", "WORK IT"). */
export function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </div>
  );
}

import { Bookmark, Hash, Info, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  CommandResult,
  ScratchActions,
} from "@/features/commands/lib/commands.ts";
import type { EphemeralDisplay } from "@/features/channels/lib/ephemeralChannel.ts";
import { cn } from "@/shared/lib/cn";
import {
  type ChannelLike,
  type ScratchInfo,
  scratchCountdown,
} from "../lib/scratchChannel.ts";

/**
 * The scratch channel's marks (Commands and Main artboards): the dashed
 * hash, the SCRATCH pill, the idle countdown, Keep / Exit, and the one-line
 * banner that says what this room is. Everything here is the same two
 * actions `/keep` and `/exit` run — a button is only ever a second way in.
 */

/** A hash drawn dashed: a channel that is not meant to last. */
export function ScratchGlyph({ className }: { className?: string }) {
  return (
    <Hash
      aria-hidden="true"
      strokeDasharray="3 2.4"
      className={cn("shrink-0", className)}
    />
  );
}

/** "SCRATCH" — the header's pill. */
export function ScratchPill() {
  return (
    <span
      data-testid="scratch-pill"
      className="shrink-0 rounded-full border border-dashed border-work bg-honey-wash px-2 font-mono text-badge font-semibold tracking-[.1em] text-honey-ink"
    >
      SCRATCH
    </span>
  );
}

/**
 * The idle countdown, re-derived every 15 s. Null until the last hour: a
 * room that lives 72 h past every message has nothing to count down before
 * then.
 */
export function useScratchCountdown(
  channel: ChannelLike,
  lastActivityAt: number | null,
): EphemeralDisplay | null {
  const [nowS, setNowS] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNowS(Date.now() / 1000), 15_000);
    return () => clearInterval(timer);
  }, []);
  return scratchCountdown(channel, lastActivityAt, nowS);
}

export function ScratchCountdown({ expiry }: { expiry: EphemeralDisplay }) {
  return (
    <span
      data-testid="scratch-countdown"
      title={expiry.title}
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 font-mono text-2xs font-medium",
        expiry.urgency === "normal"
          ? "border-honey-line bg-honey-wash text-honey-ink"
          : "border-coral-line bg-coral-wash text-coral-ink",
      )}
    >
      {expiry.label}
    </span>
  );
}

function report(result: CommandResult) {
  if (result.ok) {
    if (result.notice) {
      toast.success(result.notice);
    }
  } else {
    toast.error(result.error);
  }
}

/** Keep and Exit, as the header (md+) and the phone banner draw them. */
export function ScratchButtons({
  channelId,
  info,
  actions,
  compact = false,
}: {
  channelId: string;
  info: ScratchInfo;
  actions: ScratchActions;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const size = compact ? "h-7 px-2.5" : "h-8 px-3";
  return (
    <>
      <button
        type="button"
        data-testid="scratch-keep"
        title="Make this a permanent channel (/keep)"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void actions
            .keep({ channelId, name: null })
            .then(report)
            .finally(() => setBusy(false));
        }}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border bg-card text-xs font-semibold text-ink-2 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60",
          size,
        )}
      >
        <Bookmark aria-hidden className="size-3.5" />
        Keep
      </button>
      <button
        type="button"
        data-testid="scratch-exit"
        title={`Discard ${info.label.rest} and go back to #${info.parentName} (/exit)`}
        onClick={() =>
          void actions
            .exit({
              channelId,
              parent: { id: info.parentId, name: info.parentName },
            })
            .then(report)
        }
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-primary bg-primary text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90",
          size,
        )}
      >
        <LogOut aria-hidden className="size-3.5" />
        Exit
      </button>
    </>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <span className="rounded-[4px] bg-chip px-1 font-mono text-2xs font-semibold text-ink-2">
      {children}
    </span>
  );
}

/**
 * What this room is, under the header. At md+ the header carries the
 * buttons, so the banner is the sentence; on a phone the header is the top
 * bar, so the banner carries the pill, the countdown and the buttons too.
 */
export function ScratchBanner({
  channelId,
  info,
  actions,
  expiry,
  phone,
}: {
  channelId: string;
  info: ScratchInfo;
  actions: ScratchActions;
  expiry: EphemeralDisplay | null;
  phone: boolean;
}) {
  if (phone) {
    return (
      <div
        data-testid="scratch-banner"
        className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-[10px] border border-dashed border-honey-line bg-honey-wash py-1.5 pr-1.5 pl-2.5 text-xs text-ink-2"
      >
        <ScratchPill />
        {/* The top bar already reads "flight-path / scratch-1": in the last
            hour the countdown takes this room instead of a clipped "fro…". */}
        {expiry ? (
          <span className="flex min-w-0 flex-1">
            <ScratchCountdown expiry={expiry} />
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            from <b className="font-semibold">#{info.parentName}</b>
          </span>
        )}
        <ScratchButtons
          channelId={channelId}
          info={info}
          actions={actions}
          compact
        />
      </div>
    );
  }
  return (
    <div
      data-testid="scratch-banner"
      className="mx-5 mt-3 flex shrink-0 items-center gap-2.5 rounded-[10px] border border-dashed border-honey-line bg-honey-wash px-3 py-2 text-xs text-ink-2"
    >
      <Info aria-hidden className="size-3.75 shrink-0 text-honey-ink" />
      <span className="min-w-0">
        Same people and agents as{" "}
        <b className="font-semibold">#{info.parentName}</b>, fresh history.{" "}
        <Kbd>/keep</Kbd> makes it permanent, <Kbd>/exit</Kbd> discards it.
      </span>
    </div>
  );
}

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
  scratchPermissions,
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

/**
 * Keep / Exit / Leave, as the header (md+) and the phone banner draw them —
 * only the ones the viewer's role can actually do (`scratchPermissions`):
 * the owner gets Keep and Exit, an admin Keep and Leave, a copied member
 * Leave alone, and an unread roster nothing yet.
 */
export function ScratchButtons({
  channelId,
  info,
  actions,
  role,
  compact = false,
}: {
  channelId: string;
  info: ScratchInfo;
  actions: ScratchActions;
  role: string | null;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const may = scratchPermissions(role);
  const size = compact ? "h-7 px-2.5" : "h-8 px-3";
  const quiet = cn(
    "inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border bg-card text-xs font-semibold text-ink-2 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60",
    size,
  );
  const parent = { id: info.parentId, name: info.parentName };
  const run = (action: () => Promise<CommandResult>) => {
    setBusy(true);
    void action()
      .then(report)
      .finally(() => setBusy(false));
  };
  return (
    <>
      {may.canKeep ? (
        <button
          type="button"
          data-testid="scratch-keep"
          title="Make this a permanent channel (/keep)"
          disabled={busy}
          onClick={() => run(() => actions.keep({ channelId, name: null }))}
          className={quiet}
        >
          <Bookmark aria-hidden className="size-3.5" />
          Keep
        </button>
      ) : null}
      {may.canDiscard ? (
        <button
          type="button"
          data-testid="scratch-exit"
          title={`Discard ${info.label.rest} and go back to #${info.parentName} (/exit)`}
          onClick={() => void actions.exit({ channelId, parent }).then(report)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-primary bg-primary text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90",
            size,
          )}
        >
          <LogOut aria-hidden className="size-3.5" />
          Exit
        </button>
      ) : null}
      {may.canLeave ? (
        <button
          type="button"
          data-testid="scratch-leave"
          title={`Leave ${info.label.rest} — only its owner can discard it`}
          disabled={busy}
          onClick={() => run(() => actions.leave({ channelId, parent }))}
          className={quiet}
        >
          <LogOut aria-hidden className="size-3.5" />
          Leave
        </button>
      ) : null}
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
  role,
  expiry,
  phone,
}: {
  channelId: string;
  info: ScratchInfo;
  actions: ScratchActions;
  role: string | null;
  expiry: EphemeralDisplay | null;
  phone: boolean;
}) {
  const may = scratchPermissions(role);
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
          role={role}
          compact
        />
      </div>
    );
  }
  // Name only what this viewer can do: a copied member cannot /exit it.
  const verbs =
    may.canKeep && may.canDiscard ? (
      <>
        <Kbd>/keep</Kbd> makes it permanent, <Kbd>/exit</Kbd> discards it.
      </>
    ) : may.canKeep ? (
      <>
        <Kbd>/keep</Kbd> makes it permanent.
      </>
    ) : may.canLeave ? (
      <>Its owner can keep or discard it; you can leave.</>
    ) : null;
  return (
    <div
      data-testid="scratch-banner"
      className="mx-5 mt-3 flex shrink-0 items-center gap-2.5 rounded-[10px] border border-dashed border-honey-line bg-honey-wash px-3 py-2 text-xs text-ink-2"
    >
      <Info aria-hidden className="size-3.75 shrink-0 text-honey-ink" />
      <span className="min-w-0">
        Same people and agents as{" "}
        <b className="font-semibold">#{info.parentName}</b>, fresh history.
        {verbs ? " " : null}
        {verbs}
      </span>
    </div>
  );
}

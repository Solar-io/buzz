import type { ReactNode } from "react";
import type { ScratchActions } from "@/features/commands/lib/commands.ts";
import { memberSummary } from "@/features/channels/lib/memberSummary.ts";
import type { ChannelLike, ScratchInfo } from "../lib/scratchChannel.ts";
import {
  ScratchBanner,
  ScratchButtons,
  ScratchCountdown,
  ScratchGlyph,
  ScratchPill,
  useScratchCountdown,
} from "./ScratchChrome.tsx";

/**
 * A scratch channel's header (Commands artboard): the dashed hash,
 * "flight-path / scratch-1", the SCRATCH pill, "cloned from #flight-path ·
 * 3 agents", then the countdown (last hour only), the roster, Keep and Exit;
 * and under it the banner that says what the room is for. On a phone the
 * top bar has the title, so only the banner renders — carrying the buttons.
 *
 * When the row runs short (the Work rail docked beside it), what gives way
 * is fixed: the "cloned from" line truncates first, then the parent half of
 * the title — never "scratch-1", the pill, or the two buttons.
 */
export function ScratchHeading({
  channel,
  info,
  actions,
  lastActivityAt,
  role,
  phone,
  memberPubkeys,
  agentPubkeys,
  roster,
}: {
  channel: ChannelLike;
  info: ScratchInfo;
  actions: ScratchActions;
  lastActivityAt: number | null;
  /** The viewer's role here (39002) — decides Keep / Exit / Leave. */
  role: string | null;
  phone: boolean;
  memberPubkeys: readonly string[];
  agentPubkeys: ReadonlySet<string>;
  roster: ReactNode;
}) {
  const expiry = useScratchCountdown(channel, lastActivityAt);
  const banner = (
    <ScratchBanner
      channelId={channel.id}
      info={info}
      actions={actions}
      role={role}
      expiry={expiry}
      phone={phone}
    />
  );
  if (phone) {
    return banner;
  }
  const { agents } = memberSummary(memberPubkeys, agentPubkeys);
  return (
    <>
      <header
        data-testid="channel-header"
        data-scratch="true"
        className="flex min-h-14.5 shrink-0 items-center gap-3 border-b border-border px-5 py-2.5"
      >
        <ScratchGlyph className="size-4.5 text-honey-ink" />
        <h1 className="flex min-w-0 max-w-[50%] shrink-0 items-baseline gap-1.5 text-lg font-bold tracking-tight">
          <span className="min-w-0 truncate">{info.label.parent}</span>
          <span aria-hidden className="shrink-0 font-medium text-faint">
            /
          </span>
          <span className="max-w-[14rem] shrink-0 truncate">
            {info.label.rest}
          </span>
        </h1>
        <ScratchPill />
        <span
          data-testid="scratch-origin"
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={`Cloned from #${info.parentName}`}
        >
          cloned from #{info.parentName}
          {agents > 0
            ? ` · ${agents} ${agents === 1 ? "agent" : "agents"}`
            : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {expiry ? <ScratchCountdown expiry={expiry} /> : null}
          {roster}
          <ScratchButtons
            channelId={channel.id}
            info={info}
            actions={actions}
            role={role}
          />
        </div>
      </header>
      {banner}
    </>
  );
}

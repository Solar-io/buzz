import { useEffect } from "react";

import { MicMeter } from "./MicMeter.tsx";
import { HuddleControls } from "./HuddleControls.tsx";
import { HuddleReactionBurst } from "./HuddleReactionBurst.tsx";
import { useHuddleSession } from "../HuddleSessionProvider.tsx";

/**
 * The docked call bar, at the bottom of the channel view.
 *
 * DOCKED TO THE ROOM IT STARTED IN (Sam, 2026-09-18: "stays docked to that
 * dm or channel"): it renders on the huddle's own ephemeral channel and on
 * its parent, and nowhere else. On any other channel the call keeps running
 * and the provider shows a pill instead — a call with no visible trace is
 * the failure this pair of surfaces exists to prevent.
 *
 * Below the composer, not above the timeline, because it is call chrome
 * rather than conversation: putting it above pushes the newest message
 * around every time a control appears.
 *
 * The bar registers itself with the provider while mounted, which is how
 * the pill knows to stay out of the way.
 */
export function HuddleDock({ currentChannelId }: { currentChannelId: string }) {
  const { call, floating, setDockMounted } = useHuddleSession();
  const visible =
    call.connected &&
    !floating &&
    (currentChannelId === call.channelId ||
      currentChannelId === call.parentChannelId);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setDockMounted(true);
    return () => setDockMounted(false);
  }, [visible, setDockMounted]);

  if (!visible) {
    return null;
  }

  return (
    <div
      className="relative border-t border-border bg-card/60 px-4 py-2"
      data-testid="huddle-dock"
    >
      <HuddleReactionBurst reactions={call.reactions.active} />
      <HuddleControls variant="dock" />
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <MicMeter levelDbov={call.huddle.micLevel} muted={call.huddle.muted} />
        {call.reconnecting && (
          <span
            className="animate-pulse rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-2xs text-amber-400"
            data-testid="huddle-reconnecting"
            role="status"
          >
            Reconnecting…
          </span>
        )}
        {call.micHoldNotice !== null && (
          <span
            className="text-2xs text-muted-foreground"
            data-testid="huddle-mic-hold"
            role="status"
          >
            {call.micHoldNotice}
          </span>
        )}
        {call.voice.enabled && call.voice.interimText && (
          <span
            className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground/70"
            data-testid="huddle-voice-interim"
            title={call.voice.interimText}
          >
            {call.voice.interimText}
          </span>
        )}
        {call.huddle.error && (
          <span className="text-2xs text-red-400" role="alert">
            {call.huddle.error}
          </span>
        )}
        {call.voice.error && (
          <span className="text-2xs text-red-400" role="alert">
            {call.voice.error}
          </span>
        )}
      </div>
    </div>
  );
}

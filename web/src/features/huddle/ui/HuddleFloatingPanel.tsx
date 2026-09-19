import { GripHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  useChannelMembers,
  useChannelMessages,
  useProfiles,
} from "@/features/channels/hooks";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import { Composer } from "@/features/channels/ui/Composer";

import {
  clampPanelPosition,
  loadPanelPosition,
  savePanelPosition,
  type PanelPosition,
} from "../lib/floatingPosition.ts";
import { useHuddleSession } from "../HuddleSessionProvider.tsx";
import { HuddleControls } from "./HuddleControls.tsx";
import { HuddleReactionBurst } from "./HuddleReactionBurst.tsx";
import {
  HuddleParticipantCards,
  huddleParticipants,
} from "./HuddleParticipants.tsx";

/**
 * The floating huddle: an IN-PAGE panel, not a popup window (Sam,
 * 2026-09-18). A real window would need `window.open`, a second React root,
 * and a second relay session — and would be blocked by every popup blocker
 * the first time it opened without a click.
 *
 * It is rendered by the provider, above the router, so it is visible on
 * EVERY route — which is the entire point of floating, as against the dock,
 * which deliberately stays with its channel.
 *
 * Contents top → bottom: the participant grid, the huddle channel's own
 * timeline (voice transcripts and agent replies already land there), the
 * composer for that channel, and the same control row the dock uses.
 *
 * Escape docks it again, as does the dock/float toggle; the position is
 * remembered and clamped to the viewport on every load and resize
 * (`lib/floatingPosition.ts`).
 */

const PANEL_SIZE = { width: 380, height: 560 };

function positionStore(): Storage | null {
  return typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : null;
}

function viewport() {
  return typeof window === "undefined"
    ? { width: PANEL_SIZE.width * 2, height: PANEL_SIZE.height * 2 }
    : { width: window.innerWidth, height: window.innerHeight };
}

export function HuddleFloatingPanel() {
  const { call, setFloating } = useHuddleSession();
  const [position, setPosition] = useState<PanelPosition>(() =>
    loadPanelPosition(positionStore(), viewport(), PANEL_SIZE),
  );
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  // The latest position, for the pointer-up save: a pointer-up handler is
  // a closure over the render it was attached in, and a fast drag can end
  // before that render caught up with the last move.
  const positionRef = useRef(position);
  positionRef.current = position;

  // A window that shrank must not leave the panel stranded off-screen.
  useEffect(() => {
    const onResize = () =>
      setPosition((current) =>
        clampPanelPosition(current, viewport(), PANEL_SIZE),
      );
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFloating(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setFloating]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    setPosition(
      clampPanelPosition(
        { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
        viewport(),
        PANEL_SIZE,
      ),
    );
  }, []);
  const endDrag = useCallback((event: React.PointerEvent) => {
    if (dragRef.current === null) {
      return;
    }
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // A pointer that was never captured (synthetic, or already lost).
    }
    savePanelPosition(positionStore(), positionRef.current);
  }, []);

  const channelId = call.channelId;
  const feed = useChannelMessages(channelId);
  const members = useChannelMembers(channelId);
  const authorPubkeys = useMemo(
    () => feed.messages.map((message) => message.authorPubkey),
    [feed.messages],
  );
  const timelineProfiles = useProfiles(authorPubkeys);
  const participants = huddleParticipants(call, call.profiles);

  return (
    <section
      aria-label="Huddle"
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      data-testid="huddle-floating-panel"
      style={{
        left: position.x,
        top: position.y,
        width: PANEL_SIZE.width,
        height: PANEL_SIZE.height,
      }}
    >
      <header
        className="flex cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
        data-testid="huddle-float-handle"
        onPointerDown={(event) => {
          dragRef.current = {
            offsetX: event.clientX - position.x,
            offsetY: event.clientY - position.y,
          };
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // No active pointer for this id: the drag still works through
            // the handle's own move/up handlers while the pointer stays on it.
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <GripHorizontal
          aria-hidden
          className="h-3.5 w-3.5 text-muted-foreground"
        />
        <span className="flex-1 truncate text-xs font-medium">Huddle</span>
        <button
          aria-label="Dock the huddle"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          data-testid="huddle-float-close"
          onClick={() => setFloating(false)}
          type="button"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col gap-2 p-3">
        <HuddleReactionBurst reactions={call.reactions.active} />
        <HuddleParticipantCards participants={participants} />
        <h2 className="text-2xs uppercase tracking-wide text-muted-foreground">
          Huddle chat
        </h2>
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border">
          <ChannelTimeline
            historyExhausted={feed.historyExhausted}
            loadingOlder={feed.loadingOlder}
            messages={feed.messages}
            onLoadOlder={feed.loadOlder}
            onOpenThread={() => {}}
            profiles={timelineProfiles}
            reactions={feed.reactions}
            replyCounts={new Map()}
            selfPubkey={call.selfPubkey}
            tailKey={channelId ?? ""}
          />
          <Composer
            draftKey={channelId ?? undefined}
            members={members}
            onClearThread={() => {}}
            profiles={timelineProfiles}
            send={call.send}
            threadRef={null}
          />
        </div>
      </div>

      <footer className="border-t border-border px-3 py-2">
        <HuddleControls variant="panel" />
        {call.micHoldNotice !== null && (
          <p
            className="mt-1 text-2xs text-muted-foreground"
            data-testid="huddle-mic-hold"
            role="status"
          >
            {call.micHoldNotice}
          </p>
        )}
        {call.voice.enabled && call.voice.interimText && (
          <p
            className="mt-1 truncate text-xs italic text-muted-foreground/70"
            data-testid="huddle-voice-interim"
          >
            {call.voice.interimText}
          </p>
        )}
      </footer>
    </section>
  );
}

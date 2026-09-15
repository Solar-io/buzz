import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";

/**
 * The agent portrait as a stationary overlay in the DM chat column.
 *
 * Placement (Sam, 2026-09-14: "It's best as an overlay … over the main chat
 * area"): anchored to the top-right of the chat section, below its header —
 * NOT inside the thinking pane, where it scrolled away with the transcript
 * and was only visible at one scroll position.
 *
 * The width is fluid by construction — `min(12rem, 24%)` of the chat column —
 * so dragging the thinking/thread resize handle reflows it continuously, and
 * the transcript's matching right padding keeps the text clear of it at every
 * width ("chat shifts left slightly", same message).
 *
 * The picture is still the agent-chosen kind-0 avatar; nothing here schedules
 * or rotates it. pointer-events-none keeps it a picture on the wall: chat
 * text under it stays selectable and the timeline keeps its scroll gestures.
 */
export function AgentPortraitOverlay({
  pubkey,
  name,
  picture,
}: {
  pubkey: string;
  name: string;
  picture?: string;
}) {
  return (
    <div
      data-testid="agent-portrait"
      className="pointer-events-none absolute top-16 right-3 z-10 hidden w-[min(12rem,24%)] flex-col lg:flex"
    >
      <AuthorAvatar
        pubkey={pubkey}
        label={name}
        picture={picture}
        shape="portrait"
      />
      <div className="mt-2 text-sm font-medium">{name}</div>
      <p className="text-xs text-muted-foreground">
        Who they want you to see — they can change it anytime.
      </p>
    </div>
  );
}

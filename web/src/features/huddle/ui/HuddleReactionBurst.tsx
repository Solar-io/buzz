import { CustomEmojiImage } from "@/features/custom-emoji/ui/CustomEmojiImage";
import { reactionShortcode } from "../lib/huddleReactions.ts";
import type { ActiveHuddleReaction } from "../useHuddleReactions";

/**
 * The reaction burst: emoji floating up out of the huddle bar with the
 * sender's name under them.
 *
 * Deliberately a small local overlay rather than a port of the desktop's
 * `EmojiBurstProvider` (700 lines of physics for confetti, message reactions
 * and celebration bursts). What has to be right is that the reaction is
 * ATTRIBUTED and legible; the desktop's particle simulation is not the part
 * anyone is missing in a browser.
 *
 * `pointer-events-none` throughout: a burst must never eat a click aimed at
 * the mute button underneath it.
 *
 * Custom emoji go through `CustomEmojiImage` and not a bare `<img>`, because
 * relay-hosted media needs a signed GET — a plain `src` on a relay URL
 * renders a broken image.
 */
export function HuddleReactionBurst({
  reactions,
}: {
  reactions: readonly ActiveHuddleReaction[];
}) {
  if (reactions.length === 0) {
    return null;
  }
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex items-end justify-center gap-3 overflow-hidden pb-1"
      data-testid="huddle-reaction-burst"
    >
      {reactions.map((reaction, index) => {
        const shortcode = reactionShortcode(reaction.emoji);
        return (
          <span
            key={reaction.key}
            data-testid="huddle-reaction"
            className="flex flex-col items-center gap-0.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4"
            style={{
              // Fan the column out so simultaneous reactions do not stack
              // into one illegible pile.
              transform: `translateY(${-(index % 3) * 8}px)`,
            }}
          >
            <span className="text-2xl leading-none" aria-hidden={false}>
              {shortcode !== null && reaction.emojiUrl ? (
                <CustomEmojiImage
                  shortcode={shortcode}
                  url={reaction.emojiUrl}
                  className="h-6 w-6"
                />
              ) : (
                reaction.emoji
              )}
            </span>
            <span className="max-w-24 truncate rounded-full bg-card/80 px-1.5 py-0.5 text-2xs text-muted-foreground">
              {reaction.senderName}
            </span>
          </span>
        );
      })}
    </div>
  );
}

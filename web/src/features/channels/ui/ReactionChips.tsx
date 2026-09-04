import { useCustomEmoji } from "@/features/custom-emoji/hooks";
import { EmojiText } from "@/features/custom-emoji/ui/EmojiText";
import { cn } from "@/shared/lib/cn";
import { describeReactors, type ReactionGroup } from "../lib/reactions.ts";

/**
 * Reaction chips under a message.
 *
 * Each chip is a toggle, so it carries `aria-pressed` and reads its own
 * state: a chip the viewer is part of is filled in the primary accent (the
 * desktop's `border-primary/40 bg-primary/10 text-primary`) and clicking it
 * REMOVES the viewer's reaction rather than re-adding it. Without the pressed
 * state a screen reader announces "👍 3, button" identically whether or not
 * the viewer already reacted, and the click does the opposite thing in each
 * case.
 *
 * The `title` names the reactors, resolved through the timeline's profile
 * map, so hovering answers "who liked this" without a popover primitive.
 * TODO(primitives): promote to `shared/ui/popover` with avatars, matching
 * `desktop/.../MessageReactions.tsx`, once that primitive lands.
 */
export function ReactionChips({
  messageId,
  groups,
  nameOf,
  selfPubkey,
  onReact,
  onUnreact,
}: {
  messageId: string;
  groups: ReactionGroup[];
  /** Display name for a pubkey — the timeline's profile lookup. */
  nameOf: (pubkey: string) => string;
  selfPubkey?: string | null;
  onReact?: (messageId: string, emoji: string) => void;
  /**
   * Remove the viewer's own reaction. Absent, a self-reacted chip stays a
   * read-only pressed indicator rather than silently re-adding a reaction the
   * relay already has.
   */
  onUnreact?: (messageId: string, emoji: string) => void;
}) {
  // Read before the early return: a hook cannot sit behind a conditional.
  const palette = useCustomEmoji();
  if (groups.length === 0) {
    return null;
  }
  return (
    <div
      className="mt-1 flex flex-wrap gap-1"
      data-testid={`message-reactions-${messageId}`}
    >
      {groups.map((group) => {
        const mine = group.reactedByCurrentUser;
        const toggles = mine ? Boolean(onUnreact) : Boolean(onReact);
        return (
          <button
            key={group.emoji}
            type="button"
            aria-pressed={mine}
            aria-label={
              mine
                ? `Remove your ${group.emoji} reaction`
                : `React with ${group.emoji}`
            }
            title={describeReactors(group, nameOf, selfPubkey)}
            data-testid={`reaction-${group.emoji}-${messageId}`}
            disabled={!toggles}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm transition-colors",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              mine
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border/60 bg-card/60 text-foreground/90",
              toggles
                ? mine
                  ? "hover:bg-primary/20"
                  : "hover:bg-accent"
                : "cursor-default",
            )}
            onClick={() => {
              if (mine) {
                onUnreact?.(messageId, group.emoji);
              } else {
                onReact?.(messageId, group.emoji);
              }
            }}
          >
            <EmojiText text={group.emoji} palette={palette} />
            {group.pubkeys.length > 1 && (
              <span
                className={cn(
                  "text-xs tabular-nums",
                  mine ? "text-primary/80" : "text-muted-foreground",
                )}
              >
                {group.pubkeys.length}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

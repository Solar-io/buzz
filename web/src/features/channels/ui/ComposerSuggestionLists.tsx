import { Users } from "lucide-react";
import type { CommandSpec } from "@/features/commands/lib/commands.ts";
import { CommandList } from "@/features/commands/ui/CommandList";
import { cn } from "@/shared/lib/cn";

const NO_COMMANDS: readonly CommandSpec[] = [];

/**
 * One row of the mention autocomplete: a channel member, or the reserved
 * @everyone entry. The everyone row carries no pubkey — the token expands to
 * every member at resolve time (minus the author), so there is nothing to
 * pick and record in mentionPicks.
 */
export type MentionSuggestion =
  | { kind: "member"; name: string; pubkey: string }
  | { kind: "everyone"; name: "everyone" };

/** One :code: emoji match, as the composer's autocomplete renders it. */
export interface EmojiSuggestion {
  code: string;
  emoji: string;
}

/**
 * The mention and :emoji: autocomplete popups, extracted from `Composer.tsx`
 * when the dictation handle arrived there (the composer was at the file-size
 * ceiling; these two lists are self-contained presentational blocks).
 *
 * Both ride the same popup machinery: absolute above the field, one button
 * per row, the highlighted row carried by the parent so keyboard navigation
 * stays in the textarea's keydown handler where it has always lived.
 */
export function ComposerSuggestionLists({
  applyEmojiMatch,
  applySuggestion,
  emojiIndex,
  emojiMatches,
  popupIndex,
  suggestions,
  commandMatches = NO_COMMANDS,
  commandIndex = 0,
  onPickCommand,
  commandContext,
}: {
  applyEmojiMatch: (match: EmojiSuggestion) => void;
  applySuggestion: (name: string, pubkey?: string) => void;
  emojiIndex: number;
  emojiMatches: readonly EmojiSuggestion[];
  popupIndex: number;
  suggestions: readonly MentionSuggestion[];
  /** Slash commands matching what is being typed (Phase 2's third trigger). */
  commandMatches?: readonly CommandSpec[];
  commandIndex?: number;
  onPickCommand?: (command: CommandSpec) => void;
  /** "in #flight-path" — shown in the command list's title row. */
  commandContext?: string;
}) {
  return (
    <>
      {onPickCommand && (
        <CommandList
          commands={commandMatches}
          selected={commandIndex}
          context={commandContext}
          onPick={onPickCommand}
        />
      )}
      {suggestions.length > 0 && (
        <ul className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          {suggestions.map((row, index) => (
            <li key={row.kind === "member" ? row.pubkey : "everyone"}>
              <button
                type="button"
                className={cn(
                  "block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent",
                  index === popupIndex && "bg-accent",
                )}
                onClick={() =>
                  applySuggestion(
                    row.name,
                    row.kind === "member" ? row.pubkey : undefined,
                  )
                }
              >
                {row.kind === "member" ? (
                  `@${row.name}`
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Users
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    @everyone
                    <span className="text-muted-foreground">
                      notify all members
                    </span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {emojiMatches.length > 0 && (
        <ul className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          {emojiMatches.map((match, index) => (
            <li key={match.code}>
              <button
                type="button"
                className={cn(
                  "block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent",
                  index === emojiIndex && "bg-accent",
                )}
                onClick={() => applyEmojiMatch(match)}
              >
                {match.emoji} {match.code}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

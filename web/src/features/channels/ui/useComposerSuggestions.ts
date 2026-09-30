import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { CommandSpec } from "@/features/commands/lib/commands.ts";
import { activeMentionQuery } from "../lib/mentions.ts";
import {
  activeEmojiQuery,
  applyEmojiCompletion,
  emojiSuggestions,
} from "../lib/emojiAutocomplete.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import type {
  EmojiSuggestion,
  MentionSuggestion,
} from "./ComposerSuggestionLists.tsx";

/** Selection offsets into the composer textarea's value. */
export interface ComposerSelection {
  start: number;
  end: number;
}

/** A member with the display name the autocomplete and the resolver match. */
export interface NamedMember {
  pubkey: string;
  name: string;
}

/**
 * One autocomplete source. The first trigger with a non-empty list owns the
 * keyboard: `command` (`/`), then `mention` (`@`), then `emoji` (`:`).
 * Internal to this hook: a trigger's token detection lives in the memos below
 * because the mention token gates the emoji one.
 */
interface SuggestionTrigger<Item> {
  id: "command" | "mention" | "emoji";
  items: readonly Item[];
  index: number;
  setIndex: (update: (index: number) => number) => void;
  /** Tab (and, without `enter`, Enter): complete the token. */
  apply: (item: Item | undefined) => void;
  /** Enter, when it means something other than completing. */
  enter?: (item: Item | undefined) => void;
  /** Escape with the list open. */
  dismiss: () => void;
}

/** The slash-command list's inputs (from `useComposerCommands`). */
export interface ComposerCommandSuggestions {
  matches: readonly CommandSpec[];
  /** Enter on a row that can run without arguments. */
  onRun: (command: CommandSpec) => void;
}

/**
 * The composer's `/command`, `@mention` and `:emoji:` autocomplete. The
 * composer keeps `mentionPicks` — draft persistence and submit read it — and
 * learns about a pick through `onPickMention`.
 *
 * Commands (web redesign Phase 2) ride the same machinery: ↑↓ choose, Tab
 * completes the name, Enter RUNS it (or completes it, when it cannot run
 * without arguments), Esc closes the list until the text changes.
 */
export function useComposerSuggestions({
  text,
  selection,
  members,
  profiles,
  applyText,
  focusAt,
  onPickMention,
  commands,
}: {
  text: string;
  selection: ComposerSelection;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  applyText: (next: string) => void;
  focusAt: (start: number, end?: number) => void;
  onPickMention: (name: string, pubkey: string) => void;
  commands?: ComposerCommandSuggestions;
}) {
  const [popupIndex, setPopupIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const caret = Math.min(selection.start, text.length);

  const namedMembers = useMemo<NamedMember[]>(
    () =>
      members.map((member) => ({
        pubkey: member.pubkey,
        name:
          profiles
            .get(member.pubkey)
            ?.displayName.replace(/\s+/g, " ")
            .trim() || member.name,
      })),
    [members, profiles],
  );

  // Any edit re-arms a command list that Escape closed.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger, not a read — see the mention effect below
  useEffect(() => {
    setCommandDismissed(false);
  }, [text]);
  const commandMatches =
    commands && !commandDismissed ? commands.matches : NO_COMMANDS;
  const commandRow = Math.min(commandIndex, commandMatches.length - 1);
  const completeCommand = (command: CommandSpec) => {
    const next = `/${command.id} `;
    applyText(next);
    setCommandIndex(0);
    focusAt(next.length);
  };
  const enterCommand = (command: CommandSpec) => {
    if (command.needsArgs) {
      completeCommand(command);
    } else {
      commands?.onRun(command);
    }
  };

  // Non-null the moment an "@" token is open at the caret — including a
  // bare "@" (the regex's name group matches empty), which is what the
  // @ button leaves behind. TYPING @ therefore opens the list, not just
  // the button (Sam 2026-09-02: "if I do an @ and an agent's name,
  // nothing happens").
  const query = activeMentionQuery(text, caret);
  // A fresh token re-arms the popup after an Escape dismissal.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: `query` is the trigger, not a read — the body deliberately ignores its value and exists only to re-run when the token changes. Dropping it, as the rule suggests, would run this once at mount, so one Escape would suppress the mention popup for the rest of the session.
  useEffect(() => {
    setMentionDismissed(false);
  }, [query]);
  const suggestions = useMemo<MentionSuggestion[]>(() => {
    if (query === null || mentionDismissed) {
      return [];
    }
    const lower = query.toLowerCase();
    const matching: MentionSuggestion[] = namedMembers
      .filter((member) => member.name.toLowerCase().includes(lower))
      .slice(0, 6)
      .map((member) => ({
        kind: "member",
        name: member.name,
        pubkey: member.pubkey,
      }));
    // The reserved @everyone rides first whenever the query could be typing
    // it — including the empty query right after "@".
    if ("everyone".includes(lower)) {
      return [{ kind: "everyone", name: "everyone" }, ...matching];
    }
    return matching;
  }, [query, namedMembers, mentionDismissed]);

  const applySuggestion = (name: string, pubkey?: string) => {
    if (pubkey) {
      onPickMention(name, pubkey);
    }
    const upToCaret = text.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    if (at === -1) {
      return;
    }
    applyText(`${text.slice(0, at)}@${name} ${text.slice(caret)}`);
    setMentionDismissed(true);
    focusAt(at + name.length + 2);
  };

  // :code: emoji autocomplete — rides the same popup machinery as mentions,
  // and only when no @ token is open (mentions take precedence).
  const emojiToken = query !== null ? null : activeEmojiQuery(text, caret);
  const emojiMatches = useMemo<EmojiSuggestion[]>(
    () => (emojiToken === null ? [] : emojiSuggestions(emojiToken)),
    [emojiToken],
  );
  const applyEmojiMatch = (match: { emoji: string }) => {
    const result = applyEmojiCompletion(text, caret, match.emoji);
    applyText(result.text);
    setEmojiIndex(0);
    focusAt(result.caret);
  };

  const command: SuggestionTrigger<CommandSpec> = {
    id: "command",
    items: commandMatches,
    index: Math.max(commandRow, 0),
    setIndex: setCommandIndex,
    apply: (row) => row && completeCommand(row),
    enter: (row) => row && enterCommand(row),
    dismiss: () => {
      setCommandIndex(0);
      setCommandDismissed(true);
    },
  };
  const mention: SuggestionTrigger<MentionSuggestion> = {
    id: "mention",
    items: suggestions,
    index: popupIndex,
    setIndex: setPopupIndex,
    apply: (row) =>
      applySuggestion(
        row?.name ?? "",
        row?.kind === "member" ? row.pubkey : undefined,
      ),
    dismiss: () => {
      setPopupIndex(0);
      // Dismiss until the token changes (a fresh query re-arms it).
      setMentionDismissed(true);
    },
  };
  const emoji: SuggestionTrigger<EmojiSuggestion> = {
    id: "emoji",
    items: emojiMatches,
    index: emojiIndex,
    setIndex: setEmojiIndex,
    apply: (match) => applyEmojiMatch(match ?? emojiMatches[0]),
    dismiss: () => setEmojiIndex(0),
  };

  /** Popup keys. True = handled; the caller returns without its own keys. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    for (const trigger of [
      command,
      mention,
      emoji,
    ] as SuggestionTrigger<unknown>[]) {
      const count = trigger.items.length;
      if (count === 0) {
        continue;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        trigger.setIndex((index) => (index + 1) % count);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        trigger.setIndex((index) => (index - 1 + count) % count);
        return true;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        trigger.apply(trigger.items[trigger.index]);
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        (trigger.enter ?? trigger.apply)(trigger.items[trigger.index]);
        return true;
      }
      if (event.key === "Escape") {
        trigger.dismiss();
        return true;
      }
    }
    return false;
  };

  return {
    namedMembers,
    /** The command list is on screen (the composer swaps its hint line). */
    commandListOpen: commandMatches.length > 0,
    listProps: {
      applyEmojiMatch,
      applySuggestion,
      emojiIndex,
      emojiMatches,
      popupIndex,
      suggestions,
      commandMatches,
      commandIndex: Math.max(commandRow, 0),
      onPickCommand: enterCommand,
    },
    onKeyDown,
    /** The @ button: a bare "@" it inserts must open the list. */
    rearmMention: () => setMentionDismissed(false),
    /** Text change / blur: the mention highlight goes back to the top row. */
    resetHighlight: () => setPopupIndex(0),
  };
}

const NO_COMMANDS: readonly CommandSpec[] = [];

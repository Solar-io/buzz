/**
 * Is this draft a slash command, and which one?
 *
 * The rule the composer depends on: **a command is never sent as message
 * text** (web redesign Phase 2). So this module answers one question before
 * any send — and it has to answer it the same way for a command the client
 * knows and one it does not, or a typo'd `/remnid` would land in the channel
 * for every agent to read and act on.
 *
 * What counts as a command line:
 *
 * - the FIRST character is `/` (leading whitespace is the escape hatch: a
 *   draft starting with a space always sends as text);
 * - then a name — a letter, then letters / digits / hyphens;
 * - then whitespace or the end of the draft.
 *
 * So `/usr/local/bin is missing` is a message (a second `/` follows the
 * name, not a space), `/5 done` is a message (no letter), and `/ ` is a
 * message. A bare `/` is a command with no name yet: the list is open, and
 * Enter must not post a lone slash.
 *
 * Pure and import-free so `node --test` loads it directly.
 */

export interface ParsedCommand {
  /** Lowercased name without the slash; "" for a bare `/`. */
  name: string;
  /** Everything after the name, trimmed. */
  args: string;
}

const COMMAND_LINE = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

/** The command this draft is, or null when it is an ordinary message. */
export function parseCommand(text: string): ParsedCommand | null {
  if (text === "/") {
    return { name: "", args: "" };
  }
  const match = COMMAND_LINE.exec(text);
  if (!match) {
    return null;
  }
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * The partial name being typed, for the command list — non-null only while
 * the caret is still inside the first token (`/`, `/re`, `/remind`), so the
 * list closes the moment a space starts the arguments.
 */
export function commandQuery(text: string, caret: number): string | null {
  const match = /^\/([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (!match) {
    return null;
  }
  // The caret must be at the end of the first token, not in the middle of a
  // longer draft whose head happens to look like one.
  const rest = text.slice(caret);
  if (rest !== "" && !/^\s/.test(rest)) {
    return null;
  }
  return match[1].toLowerCase();
}

/** The inline error for a name the registry does not know. */
export function unknownCommandMessage(name: string): string {
  return name === ""
    ? "Type a command after / — nothing was sent."
    : `Unknown command /${name} — not sent. Start with a space to send it as text.`;
}

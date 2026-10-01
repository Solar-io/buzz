import { useMemo, useState } from "react";
import {
  type CommandContext,
  type CommandMessage,
  type CommandSpec,
  matchCommands,
  resolveCommand,
} from "./lib/commands.ts";
import {
  commandQuery,
  type ParsedCommand,
  parseCommand,
  unknownCommandMessage,
} from "./lib/parseCommand.ts";

/** What the composer's owner supplies for commands to run against. */
export interface ComposerCommandHost {
  channel: CommandContext["channel"];
  /** The open conversation's buffer (for `/remind`'s target). */
  messages: readonly CommandMessage[];
  createReminder: CommandContext["actions"]["createReminder"];
  openWorkForChannel: (channelId: string) => void;
  /** `/new`, `/exit`, `/keep`; absent, they are not offered. */
  scratch?: CommandContext["actions"]["scratch"];
  /** `/bug`, `/backlog`; absent, they are not offered. */
  items?: CommandContext["actions"]["items"];
}

/**
 * `host` decides what a slash line does in a composer:
 *
 * - a host object — commands run here (the channel's main composer);
 * - `"elsewhere"` — this box cannot run commands (a thread reply box), and a
 *   slash line is REFUSED rather than posted: someone typing `/status` out of
 *   habit must not publish the word to a channel full of agents;
 * - undefined — the box has no notion of commands (forum posts, huddle
 *   chat), and its text is sent exactly as before.
 */
export type ComposerCommands = ComposerCommandHost | "elsewhere" | undefined;

const ELSEWHERE =
  "Commands run from the channel's message box — nothing was sent.";

/**
 * The composer's slash-command half (web redesign Phase 2): the list's
 * matches for what is being typed, and `intercept`, which the composer calls
 * BEFORE its send path. `intercept` returning true means the draft was a
 * command — run, refused or unknown — and the composer must not send it.
 */
export function useComposerCommands(options: {
  host: ComposerCommands;
  text: string;
  caret: number;
  selfPubkey: string | null;
  members: readonly { pubkey: string; name: string }[];
  mentionPicks: ReadonlyMap<string, string>;
  send: CommandContext["actions"]["send"];
  /** A command ran: clear the draft. `notice` is its confirmation, if any. */
  onRan: (notice: string | undefined) => void;
}) {
  const { host, text, caret } = options;
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const context = (): CommandContext | null =>
    typeof host === "object"
      ? {
          channel: host.channel,
          selfPubkey: options.selfPubkey,
          messages: host.messages,
          members: options.members,
          mentionPicks: options.mentionPicks,
          nowMs: Date.now(),
          actions: {
            createReminder: host.createReminder,
            send: options.send,
            openWorkForChannel: host.openWorkForChannel,
            scratch: host.scratch,
            items: host.items,
          },
        }
      : null;

  const query = typeof host === "object" ? commandQuery(text, caret) : null;
  // What decides the list besides the query: the channel, and whether it is
  // scratch (`/keep` turns a scratch channel into an ordinary one in place).
  const listKey =
    typeof host === "object"
      ? `${host.channel?.id ?? ""}|${host.channel?.scratch?.parentId ?? ""}|${host.scratch ? 1 : 0}|${host.items ? 1 : 0}`
      : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `context()` reads the latest props; the list only changes with the query and `listKey`
  const matches = useMemo<CommandSpec[]>(() => {
    const ctx = context();
    return query === null || !ctx
      ? []
      : // The composer knows the channel, so a row reads in its terms:
        // "Discard scratch-1 and go back to #flight-path".
        matchCommands(query, ctx).map((spec) =>
          spec.detail ? { ...spec, describe: spec.detail(ctx) } : spec,
        );
  }, [query, listKey]);

  const run = async (parsed: ParsedCommand): Promise<void> => {
    const ctx = context();
    if (!ctx) {
      setError(ELSEWHERE);
      return;
    }
    const resolved = resolveCommand(parsed, ctx);
    if (resolved.kind === "unknown") {
      setError(unknownCommandMessage(resolved.name));
      return;
    }
    setRunning(true);
    try {
      const result = await resolved.spec.run(ctx, resolved.args);
      if (result.ok) {
        setError(null);
        options.onRan(result.notice);
      } else {
        setError(result.error);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(false);
    }
  };

  return {
    /** Commands can be typed here (drives the hint and the `/` button). */
    enabled: typeof host === "object",
    /** Rows for the list; empty when no command token is being typed. */
    matches,
    error,
    running,
    clearError: () => setError(null),
    /**
     * Call before sending. True = the draft IS a command — do NOT send it.
     * It is run (or refused with an inline error) unless `blocked`: a second
     * Enter while a command or a send is still in flight must neither run it
     * twice nor fall through to the send path.
     */
    intercept: (draft: string, blocked = false): boolean => {
      if (host === undefined) {
        return false;
      }
      const parsed = parseCommand(draft.trimEnd());
      if (!parsed) {
        return false;
      }
      if (!blocked && !running) {
        void run(parsed);
      }
      return true;
    },
    /** Enter on a list row: run it (the row decides run vs. complete). */
    run: (spec: CommandSpec) => run({ name: spec.id, args: "" }),
  };
}

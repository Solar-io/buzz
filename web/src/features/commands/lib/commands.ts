/**
 * The slash-command registry (web redesign Phase 2).
 *
 * One entry per command: `{id, args, when(ctx), run(ctx, args)}` plus the two
 * strings the list draws. A command appears only once it WORKS — Phase 2
 * ships `/remind`, `/handoff` and `/status`; `/new`, `/exit`, `/keep`, `/bug`
 * and `/backlog` join with the phases that build what they do (plan rule 2:
 * no control that lies).
 *
 * `run` never touches the relay itself. Everything a command does goes
 * through `ctx.actions`, which the composer's host supplies, so the registry
 * is pure enough to test with fakes and cannot grow a second send path.
 */

import {
  longestMentionMatch,
  resolveMentions,
} from "../../channels/lib/mentions.ts";
import { SYSTEM_MESSAGE_KIND } from "../../channels/lib/systemEvent.ts";
import { quickRemindDueAt } from "../../reminders/lib/quickRemind.ts";
import type { ReminderTarget } from "../../reminders/lib/reminderTypes.ts";
import type { ParsedCommand } from "./parseCommand.ts";
import { parseRemindWhen, remindWhenLabel } from "./remindWhen.ts";

/** The slice of a timeline message a command reads. */
export interface CommandMessage {
  id: string;
  channelId: string;
  authorPubkey: string;
  createdAt: number;
  content: string;
  kind: number;
  mentionPubkeys: readonly string[];
  deleted?: boolean;
}

export interface CommandContext {
  /** The open conversation; null where a composer has none. */
  channel: { id: string; name: string; type: string } | null;
  selfPubkey: string | null;
  /** The open conversation's buffer, oldest first. */
  messages: readonly CommandMessage[];
  /** Members with the display names the @ autocomplete inserts. */
  members: readonly { pubkey: string; name: string }[];
  /** Pubkeys the author picked from the autocomplete, by lowercased name. */
  mentionPicks: ReadonlyMap<string, string>;
  nowMs: number;
  actions: {
    /** Publish a reminder (kind 30300); rejects with the relay's words. */
    createReminder: (input: {
      target: ReminderTarget;
      notBefore: number;
    }) => Promise<void>;
    /** The composer's own send path — one message, checked verdict. */
    send: (options: {
      content: string;
      mentionPubkeys: string[];
      threadRef: null;
      mediaTags: string[][];
    }) => Promise<{ ok: boolean; message: string }>;
    /** Show Work scoped to a channel (the rail at lg, the page below). */
    openWorkForChannel: (channelId: string) => void;
  };
}

export type CommandResult =
  | { ok: true; notice?: string }
  | { ok: false; error: string };

export type CommandGroup = "capture" | "agents";

export interface CommandSpec {
  /** The name typed after the slash. */
  id: string;
  /** Usage hint shown after the name: "[when]", "@seat <task>", "". */
  args: string;
  group: CommandGroup;
  describe: string;
  /** Offered (and runnable) in this context. */
  when: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, args: string) => Promise<CommandResult>;
}

export const COMMAND_GROUP_LABEL: Record<CommandGroup, string> = {
  capture: "Capture",
  agents: "Agents",
};

/** The tag a `/handoff` message carries: `["handoff", <seat pubkey>]`. */
export const HANDOFF_TAG = "handoff";

/**
 * "The last message aimed at me": the newest message in the buffer from
 * someone else that mentions me — or, in a DM, from someone else at all
 * (every DM message is aimed at its reader).
 */
export function remindTarget(
  messages: readonly CommandMessage[],
  selfPubkey: string | null,
  isDm: boolean,
): CommandMessage | null {
  if (!selfPubkey) {
    return null;
  }
  const self = selfPubkey.toLowerCase();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.deleted ||
      message.kind === SYSTEM_MESSAGE_KIND ||
      message.authorPubkey.toLowerCase() === self
    ) {
      continue;
    }
    if (
      isDm ||
      message.mentionPubkeys.some((pubkey) => pubkey.toLowerCase() === self)
    ) {
      return message;
    }
  }
  return null;
}

const remind: CommandSpec = {
  id: "remind",
  args: "[when]",
  group: "capture",
  describe: "Remind me about the last message aimed at me",
  when: (ctx) => ctx.channel !== null && ctx.selfPubkey !== null,
  run: async (ctx, args) => {
    const target = remindTarget(
      ctx.messages,
      ctx.selfPubkey,
      ctx.channel?.type === "dm",
    );
    if (!target) {
      return {
        ok: false,
        error: "Nothing here is aimed at you yet — no reminder was set.",
      };
    }
    let notBefore: number;
    if (args === "") {
      notBefore = quickRemindDueAt(ctx.nowMs);
    } else {
      const when = parseRemindWhen(args, ctx.nowMs);
      if (!when) {
        return {
          ok: false,
          error: `I can't read "${args}" as a time. Try 30m, 2h, tomorrow, 3pm or monday.`,
        };
      }
      notBefore = when.at;
    }
    try {
      await ctx.actions.createReminder({
        target: {
          eventId: target.id,
          channelId: target.channelId,
          preview: target.content,
          authorPubkey: target.authorPubkey,
        },
        notBefore,
      });
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not set the reminder.",
      };
    }
    return {
      ok: true,
      notice: `Reminder set for ${remindWhenLabel(notBefore, ctx.nowMs)}`,
    };
  },
};

const handoff: CommandSpec = {
  id: "handoff",
  args: "@seat <task>",
  group: "agents",
  describe: "Hand work to a seat as a tracked handoff",
  when: (ctx) => ctx.channel !== null,
  run: async (ctx, args) => {
    if (!args.startsWith("@")) {
      return {
        ok: false,
        error: "Name the seat first: /handoff @seat <task>.",
      };
    }
    const members = ctx.members.map((member) => ({ ...member }));
    const names = [
      ...members.map((member) => member.name),
      ...ctx.mentionPicks.keys(),
    ];
    const seatName = longestMentionMatch(args, 0, names);
    const seat =
      seatName === null
        ? null
        : (resolveMentions(
            args.slice(0, 1 + seatName.length),
            members,
            ctx.mentionPicks,
            ctx.selfPubkey ?? undefined,
          ).mentionPubkeys[0] ?? null);
    if (seatName === null || seat === null) {
      return {
        ok: false,
        error:
          "That seat isn't one member of this channel. Pick it from the @ list.",
      };
    }
    const task = args.slice(1 + seatName.length).trim();
    if (task === "") {
      return {
        ok: false,
        error: "Say what to hand off: /handoff @seat <task>.",
      };
    }
    const label = args.slice(1, 1 + seatName.length);
    const content = `@${label} ${task}`;
    const others = resolveMentions(
      content,
      members,
      ctx.mentionPicks,
      ctx.selfPubkey ?? undefined,
    ).mentionPubkeys.filter((pubkey) => pubkey !== seat);
    let result: { ok: boolean; message: string };
    try {
      result = await ctx.actions.send({
        content,
        mentionPubkeys: [seat, ...others],
        threadRef: null,
        mediaTags: [[HANDOFF_TAG, seat]],
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // `publish()` resolves `{ok:false}` on a relay refusal — it does not
    // throw (AGENTS.md, web send-path traps). The relay's words are the error.
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          error: result.message || "The relay rejected the handoff.",
        };
  },
};

const status: CommandSpec = {
  id: "status",
  args: "",
  group: "agents",
  describe: "What's running and queued in this channel",
  when: (ctx) => ctx.channel !== null,
  run: async (ctx) => {
    if (!ctx.channel) {
      return { ok: false, error: "Open a channel first." };
    }
    ctx.actions.openWorkForChannel(ctx.channel.id);
    return { ok: true };
  },
};

/** Every command this build can run, in list order. */
export const COMMANDS: readonly CommandSpec[] = [remind, handoff, status];

/** The commands offered in `ctx`. */
export function availableCommands(ctx: CommandContext): CommandSpec[] {
  return COMMANDS.filter((command) => command.when(ctx));
}

/** Available commands whose name starts with the typed prefix. */
export function matchCommands(
  query: string,
  ctx: CommandContext,
): CommandSpec[] {
  const prefix = query.toLowerCase();
  return availableCommands(ctx).filter((command) =>
    command.id.startsWith(prefix),
  );
}

export type ResolvedCommand =
  | { kind: "known"; spec: CommandSpec; args: string }
  | { kind: "unknown"; name: string };

/**
 * Known or unknown — never "not a command". A parsed command that the
 * registry does not offer here is UNKNOWN, and the composer refuses to send
 * it: falling through to "then it must be a message" is how a mistyped
 * command would reach the wire.
 */
export function resolveCommand(
  parsed: ParsedCommand,
  ctx: CommandContext,
): ResolvedCommand {
  const spec = availableCommands(ctx).find(
    (command) => command.id === parsed.name,
  );
  return spec
    ? { kind: "known", spec, args: parsed.args }
    : { kind: "unknown", name: parsed.name };
}

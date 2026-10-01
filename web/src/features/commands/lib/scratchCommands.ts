/**
 * `/new`, `/exit` and `/keep` — scratch channels (web redesign Phase 3).
 *
 * The registry half only: which channel each command is offered in, and
 * which parent a scratch copy belongs to. What the commands DO — publish,
 * copy the roster, navigate, hold the Undo window — is the host's
 * `actions.scratch` (`features/scratch/useScratch.ts`), for the same reason
 * every command goes through `ctx.actions`: the registry stays pure, and
 * there is one send path.
 *
 * Only type imports from `commands.ts`, which imports these specs: a runtime
 * import back would be a cycle.
 */

import {
  type ScratchPermissions,
  scratchPermissions,
} from "../../scratch/lib/scratchChannel.ts";
import type { CommandContext, CommandSpec } from "./commands.ts";

/** The parent a `/new` copies: this channel, or a scratch's own parent. */
export function scratchParentOf(
  channel: NonNullable<CommandContext["channel"]>,
): { id: string; name: string } {
  return channel.scratch
    ? { id: channel.scratch.parentId, name: channel.scratch.parentName }
    : { id: channel.id, name: channel.name };
}

/**
 * In a scratch channel AND allowed to: the relay refuses a non-owner's 9008
 * and a member's ttl edit, so those commands are not offered to them at all
 * (typed anyway, they resolve as unknown and nothing is sent).
 */
const inScratchAs =
  (may: keyof ScratchPermissions) =>
  (ctx: CommandContext): boolean =>
    ctx.channel?.scratch != null &&
    ctx.actions.scratch !== undefined &&
    scratchPermissions(ctx.channel.scratch.role)[may];

const scratchNew: CommandSpec = {
  id: "new",
  args: "[name]",
  needsArgs: false,
  group: "channel",
  describe: "A scratch copy of this channel — same people, fresh history",
  detail: (ctx) =>
    ctx.channel?.scratch
      ? "Another scratch copy to work in parallel"
      : `Scratch copy of #${ctx.channel?.name ?? ""} — same people, fresh history`,
  // Streams only: a DM has no roster to copy (its members are its title),
  // and a forum's composer is its posts view, not this one.
  when: (ctx) =>
    ctx.channel?.type === "stream" && ctx.actions.scratch !== undefined,
  run: async (ctx, args) => {
    if (!ctx.channel || !ctx.actions.scratch) {
      return { ok: false, error: "Open a channel first." };
    }
    return ctx.actions.scratch.create({
      parent: scratchParentOf(ctx.channel),
      name: args === "" ? null : args,
    });
  },
};

const scratchExit: CommandSpec = {
  id: "exit",
  args: "",
  needsArgs: false,
  group: "channel",
  describe: "Discard this scratch channel and go back",
  detail: (ctx) =>
    ctx.channel?.scratch
      ? `Discard ${ctx.channel.scratch.label} and go back to #${ctx.channel.scratch.parentName}`
      : "Discard this scratch channel and go back",
  when: inScratchAs("canDiscard"),
  run: async (ctx) => {
    if (!ctx.channel?.scratch || !ctx.actions.scratch) {
      return { ok: false, error: "/exit only works in a scratch channel." };
    }
    return ctx.actions.scratch.exit({
      channelId: ctx.channel.id,
      parent: scratchParentOf(ctx.channel),
    });
  },
};

const scratchKeep: CommandSpec = {
  id: "keep",
  args: "[name]",
  needsArgs: false,
  group: "channel",
  describe: "Make this a permanent channel",
  when: inScratchAs("canKeep"),
  run: async (ctx, args) => {
    if (!ctx.channel?.scratch || !ctx.actions.scratch) {
      return { ok: false, error: "/keep only works in a scratch channel." };
    }
    return ctx.actions.scratch.keep({
      channelId: ctx.channel.id,
      name: args === "" ? null : args,
    });
  },
};

/** In list order: the channel's own commands lead the Commands artboard. */
export const SCRATCH_COMMANDS: readonly CommandSpec[] = [
  scratchNew,
  scratchExit,
  scratchKeep,
];

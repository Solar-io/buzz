/**
 * `/bug <title>` and `/backlog <item>` — Items (web redesign Phase 5).
 *
 * The registry half only: when they are offered, how the title is checked,
 * and what they ask the host to do. Filing — the kind-30623 head, the
 * confirmation row, the Undo toast — is the host's `actions.items`
 * (`features/items/useItemActions.ts`), for the reason every command goes
 * through `ctx.actions`: the registry stays pure, and there is one send path.
 *
 * Only type imports from `commands.ts`, which imports these specs.
 */

import {
  charCount,
  ITEM_TITLE_MAX_CHARS,
  type ItemType,
  rustTrim,
} from "../../items/lib/itemEvent.ts";
import type { CommandContext, CommandResult, CommandSpec } from "./commands.ts";

/** What the item commands do; the host runs them against the relay. */
export interface ItemCommandActions {
  /**
   * File an item from this conversation: the head (kind 30623, `h` = the
   * channel), then the confirmation row that links it. Resolves with the
   * relay's verdict in the command's shape.
   */
  file: (input: {
    type: ItemType;
    title: string;
    channelId: string;
  }) => Promise<CommandResult>;
  /** The project a new item from this channel is filed under, if any. */
  projectFor: (channelId: string) => string | null;
}

/** The title check, before anything is signed: empty and over-long refuse. */
export function itemTitleError(type: ItemType, args: string): string | null {
  const title = rustTrim(args);
  if (title === "") {
    return type === "bug"
      ? "Say what broke: /bug <title>."
      : "Say what to add: /backlog <item>.";
  }
  const count = charCount(title);
  if (count > ITEM_TITLE_MAX_CHARS) {
    return `Keep the title to ${ITEM_TITLE_MAX_CHARS} characters — this one is ${count}. Put the detail in the item afterwards.`;
  }
  return null;
}

const offered = (ctx: CommandContext): boolean =>
  ctx.channel !== null &&
  ctx.selfPubkey !== null &&
  ctx.actions.items !== undefined;

function projectOf(ctx: CommandContext): string | null {
  return ctx.channel && ctx.actions.items
    ? ctx.actions.items.projectFor(ctx.channel.id)
    : null;
}

function spec(type: ItemType): CommandSpec {
  return {
    id: type,
    args: type === "bug" ? "<title>" : "<item>",
    needsArgs: true,
    group: "capture",
    describe:
      type === "bug"
        ? "File a bug in this channel's project"
        : "Add an item to the project backlog",
    detail: (ctx) => {
      const project = projectOf(ctx);
      if (type === "bug") {
        return project ? `File a bug in ${project}` : "File a bug from here";
      }
      return project
        ? `Add an item to the ${project} backlog`
        : "Add an item to the backlog";
    },
    when: offered,
    run: async (ctx, args) => {
      if (!ctx.channel || !ctx.actions.items) {
        return { ok: false, error: "Open a channel first." };
      }
      const error = itemTitleError(type, args);
      if (error) {
        return { ok: false, error };
      }
      return ctx.actions.items.file({
        type,
        title: rustTrim(args),
        channelId: ctx.channel.id,
      });
    },
  };
}

/** In list order, under Capture: `/bug`, then `/backlog` (Commands artboard). */
export const ITEM_COMMANDS: readonly CommandSpec[] = [
  spec("bug"),
  spec("backlog"),
];

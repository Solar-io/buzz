import { type ComponentProps, useMemo } from "react";
import { Composer } from "@/features/channels/ui/Composer";
import { useRemindMeLater } from "@/features/reminders/ui/RemindMeLaterProvider";
import type { ComposerCommandHost } from "../useComposerCommands.ts";

type ComposerProps = ComponentProps<typeof Composer>;

/**
 * The channel's main composer with slash commands wired up.
 *
 * A thin wrapper, and it exists for one reason: the route that renders the
 * composer sits ABOVE `RemindMeLaterProvider` in the tree, so it cannot read
 * the reminder context `/remind` needs. This component sits below it, takes
 * the rest of the command host from the route, and hands the composer the
 * complete `commands` object.
 */
export function CommandComposer({
  host,
  ...props
}: Omit<ComposerProps, "commands" | "commandContext"> & {
  host: Omit<ComposerCommandHost, "createReminder">;
}) {
  const { createReminder } = useRemindMeLater();
  const { channel, messages, openWorkForChannel } = host;
  const commands = useMemo<ComposerCommandHost>(
    () => ({ channel, messages, openWorkForChannel, createReminder }),
    [channel, messages, openWorkForChannel, createReminder],
  );
  const where = !channel
    ? undefined
    : channel.type === "dm"
      ? `in your DM with ${channel.name}`
      : `in #${channel.name}`;
  return <Composer {...props} commands={commands} commandContext={where} />;
}

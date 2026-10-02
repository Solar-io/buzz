import { type ComponentProps, useMemo } from "react";
import { Composer } from "@/features/channels/ui/Composer";
import { useItemActions } from "@/features/items/useItemActions.ts";
import { useRemindMeLater } from "@/features/reminders/ui/RemindMeLaterProvider";
import type { ComposerCommandHost } from "../useComposerCommands.ts";

type ComposerProps = ComponentProps<typeof Composer>;

/**
 * The channel's main composer with slash commands wired up.
 *
 * A thin wrapper, and it exists for one reason: the route that renders the
 * composer sits ABOVE `RemindMeLaterProvider` in the tree, so it cannot read
 * the reminder context `/remind` needs — nor the Items provider `/bug` and
 * `/backlog` file through. This component sits below both, takes the rest of
 * the command host from the route, and hands the composer the complete
 * `commands` object.
 */
export function CommandComposer({
  host,
  readOnly = false,
  ...props
}: Omit<ComposerProps, "commands" | "commandContext"> & {
  host: Omit<ComposerCommandHost, "createReminder" | "items">;
  readOnly?: boolean;
}) {
  const { createReminder } = useRemindMeLater();
  const items = useItemActions().commandActions;
  const { channel, messages, openWorkForChannel, scratch } = host;
  const commands = useMemo<ComposerCommandHost>(
    () => ({
      channel,
      messages,
      openWorkForChannel,
      createReminder,
      scratch,
      items,
    }),
    [channel, messages, openWorkForChannel, createReminder, scratch, items],
  );
  const where = !channel
    ? undefined
    : channel.type === "dm"
      ? `in your DM with ${channel.name}`
      : `in #${channel.name}`;
  if (readOnly)
    return (
      <>
        <p
          data-testid="archived-composer"
          className="border-t border-border p-4 text-sm text-muted-foreground"
        >
          This channel is archived. Unarchive it to send messages.
        </p>
        {props.actionsBar}
      </>
    );
  return <Composer {...props} commands={commands} commandContext={where} />;
}

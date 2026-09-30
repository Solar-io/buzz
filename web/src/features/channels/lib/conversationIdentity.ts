import type { CommandContext } from "../../commands/lib/commands.ts";
import { scratchInfo } from "../../scratch/lib/scratchChannel.ts";

/**
 * The open conversation's name, as the shell shows it and as the slash
 * commands see it: "# flight-path", a DM's participants, or — for a scratch
 * channel (Phase 3) — "flight-path / scratch-1" with its parent attached.
 *
 * Lifted out of `routes/repos.tsx`, which sits at the file-size ceiling.
 */
export function conversationIdentity(
  current: {
    id: string;
    name: string;
    type: string;
    about?: string | null;
    ttlSeconds: number | null;
    participantPubkeys: string[];
  } | null,
  channels: readonly { id: string; name: string }[],
  dmName: (participantPubkeys: string[]) => string,
): { title: string | null; commandChannel: CommandContext["channel"] } {
  if (!current) {
    return { title: null, commandChannel: null };
  }
  const dm = current.type === "dm";
  const scratch = dm ? null : scratchInfo(current, channels);
  return {
    title: dm
      ? dmName(current.participantPubkeys)
      : scratch
        ? `${scratch.label.parent} / ${scratch.label.rest}`
        : `# ${current.name}`,
    commandChannel: {
      id: current.id,
      name: dm ? dmName(current.participantPubkeys) : current.name,
      type: current.type,
      scratch: scratch && {
        parentId: scratch.parentId,
        parentName: scratch.parentName,
        label: scratch.label.rest,
      },
    },
  };
}

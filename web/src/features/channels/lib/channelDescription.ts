/**
 * The one line of context a channel header shows under (or beside) its name.
 *
 * Ported from the desktop's `features/channels/lib/channelDescription.ts`,
 * including the two decisions that are easy to get wrong:
 *
 * - **Only ONE detail field renders.** A relay channel can carry `topic`,
 *   `about` and `purpose` at once (all three are separate tags on the
 *   kind-39000 — see `emit_group_discovery_events`), and in practice they
 *   overlap heavily. Concatenating them produces the same sentence three
 *   times, so the first non-empty one in `topic → about → purpose` order
 *   wins and the rest are dropped.
 * - **State prefixes lead.** "Archived." and the read-only notice are the
 *   things a reader needs before the topic, because they change what the
 *   channel IS rather than describing it.
 */

export interface ChannelDescriptionInput {
  /** Kind-39000 `topic` tag. */
  topic?: string | null;
  /** Kind-39000 `about` tag (the relay's channel description). */
  about?: string | null;
  /** Kind-39000 `purpose` tag. */
  purpose?: string | null;
  /** Relay `archived` tag is set. */
  archived?: boolean;
  /**
   * The viewer is a member. `undefined` means "not known yet" and renders no
   * notice at all — claiming read-only before the roster lands would flash a
   * false warning on every channel switch.
   */
  isMember?: boolean;
  /** Anyone may join without an invite (the relay's `public` tag). */
  isOpen?: boolean;
}

/** Fallback when a channel has no topic, about or purpose of its own. */
export const DEFAULT_CHANNEL_DESCRIPTION = "Channel details and activity.";

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function channelDescription(input: ChannelDescriptionInput): string {
  const prefixes: string[] = [];
  if (input.archived) {
    prefixes.push("Archived.");
  }
  if (input.isMember === false && input.isOpen) {
    prefixes.push("Read-only until you join this open channel.");
  }
  const detail =
    nonEmpty(input.topic) ?? nonEmpty(input.about) ?? nonEmpty(input.purpose);
  const parts = [...prefixes, detail].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" ") : DEFAULT_CHANNEL_DESCRIPTION;
}

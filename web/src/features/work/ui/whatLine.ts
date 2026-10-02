import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import type { TriggerAsk } from "../lib/workTypes.ts";

/**
 * What a Running / Queued / Done row is about: the agent's own `buzz status
 * set` title, then its own in-turn message, then "Asker: ask/parent".
 * Null when none is known (yet).
 */
export function whatLine(
  title: string | null | undefined,
  ask: TriggerAsk | null | undefined,
  profiles: Map<string, Profile>,
  latest?: string | null,
): string | null {
  if (title) {
    return title;
  }
  if (latest) {
    return latest;
  }
  if (!ask) {
    return null;
  }
  return `${authorLabel(ask.authorPubkey, profiles)}: ${ask.text}`;
}

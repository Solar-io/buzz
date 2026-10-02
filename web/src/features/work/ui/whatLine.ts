import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import type { TriggerAsk } from "../lib/workTypes.ts";

/**
 * What a Running / Queued / Done row is about: the agent's own `buzz status
 * set` title when it set one, else the message that started the work —
 * "Sam: first line of the ask". Null when neither is known (yet).
 */
export function whatLine(
  title: string | null | undefined,
  ask: TriggerAsk | null | undefined,
  profiles: Map<string, Profile>,
): string | null {
  if (title) {
    return title;
  }
  if (!ask) {
    return null;
  }
  return `${authorLabel(ask.authorPubkey, profiles)}: ${ask.text}`;
}

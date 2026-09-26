import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type LastConversation,
  landingRedirectTarget,
  loadLastConversation,
} from "./lastConversation.ts";

/**
 * The browser-side glue for `lastConversation.ts`: which storage and scope
 * (the relay URL), and the hand-off from the route's `beforeLoad` redirect to
 * the shell that must validate what it restored.
 */

export function lastConversationStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function lastConversationScope(): string {
  try {
    return relayWsUrl();
  } catch {
    // Native app with no relay configured yet: nothing to restore into.
    return "unconfigured";
  }
}

let restoredLanding: LastConversation | null = null;

/**
 * `beforeLoad` for `/repos` (and `/`): the conversation to redirect a bare
 * landing to, or null. Records the restore so the shell validates it.
 */
export function restoredLandingTarget(search: {
  c?: string;
  view?: string;
  m?: string;
}): string | null {
  const stored = loadLastConversation(
    lastConversationStorage(),
    lastConversationScope(),
  );
  const target = landingRedirectTarget(search, stored);
  restoredLanding = target !== null ? stored : null;
  return target;
}

/** The shell takes the pending restore exactly once. */
export function consumeRestoredLanding(): LastConversation | null {
  const restored = restoredLanding;
  restoredLanding = null;
  return restored;
}

import { redirect } from "@tanstack/react-router";

import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  type LastConversation,
  landingRedirectTarget,
  loadLastConversation,
  phoneLandingView,
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

/** Below `md` (48rem) — the same query as AppShell's `usePhoneLayout`. */
function isPhoneViewport(): boolean {
  try {
    return globalThis.matchMedia?.("(width < 48rem)").matches ?? false;
  } catch {
    return false;
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
  if (target !== null) {
    restoredLanding = stored;
  } else if (search.c !== restoredLanding?.channelId) {
    // beforeLoad runs AGAIN for the redirect's own /repos?c=<restored>; that
    // second pass must keep the pending restore, or the shell never learns
    // the id came from storage (QA 2026-09-26: a stale id stuck forever).
    restoredLanding = null;
  }
  return target;
}

/**
 * The `/repos` route's `beforeLoad`: a bare landing redirects to the last
 * conversation BEFORE the first paint. Only fires with no c, view or m —
 * the redirect carries c, which is the loop guard.
 */
export function landingBeforeLoad({
  search,
}: {
  search: { c?: string; view?: string; m?: string };
}): void {
  // Phone (below md, AppShell's breakpoint): Work is the home screen.
  if (phoneLandingView(search, isPhoneViewport()) !== null) {
    throw redirect({ to: "/repos", search: { view: "work" }, replace: true });
  }
  const target = restoredLandingTarget(search);
  if (target !== null) {
    throw redirect({ to: "/repos", search: { c: target }, replace: true });
  }
}

/** The shell takes the pending restore exactly once. */
export function consumeRestoredLanding(): LastConversation | null {
  const restored = restoredLanding;
  restoredLanding = null;
  return restored;
}

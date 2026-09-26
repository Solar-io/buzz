import { useEffect, useMemo, useRef, useState } from "react";

import { decideDefaultConversation } from "@/features/dms/lib/defaultConversation";

import {
  clearLastConversation,
  restoreVerdict,
  saveLastConversation,
} from "./lastConversation.ts";
import {
  consumeRestoredLanding,
  lastConversationScope,
  lastConversationStorage,
} from "./lastConversationScope.ts";

/**
 * Where `/repos` lands, extracted from the route (plan item 5).
 *
 * 1. The route's `beforeLoad` already redirected a bare `/repos` to the last
 *    conversation Sam opened (see `lastConversation.ts`), so the first paint
 *    is that conversation — never "Pick a channel". This hook validates it
 *    against the channel list and, if it is gone (deleted, hidden, another
 *    identity's), clears it and drops back to a bare `/repos`.
 * 2. Default conversation (D-025), unchanged: with nothing selected, land in
 *    the most recently active DM once the durable sampling window settles
 *    (5 s hard cap). It stands down while a restored conversation is still
 *    being validated.
 * 3. Every selected conversation is remembered for the next load.
 *
 * `showSkeleton` is true while the landing is still undecided, so the empty
 * "Pick a channel" state only appears when D-025 genuinely stood down (or a
 * deep-linked channel is confirmed missing).
 */
export function useLandingConversation({
  selectedId,
  view,
  connected,
  channelIds,
  samplingSettled,
  visibleDms,
  hiddenDmIds,
  selfPubkey,
  openConversation,
  clearConversation,
}: {
  selectedId: string | undefined;
  view: string | undefined;
  connected: boolean;
  channelIds: readonly string[];
  samplingSettled: boolean;
  /** Activity-sorted visible DMs (hidden excluded), as the sidebar lists them. */
  visibleDms: ReadonlyArray<{ lastActivity: number; channel: { id: string } }>;
  hiddenDmIds: readonly string[];
  selfPubkey: string | null;
  /** Replace-navigate to a conversation (the D-025 pick). */
  openConversation: (channelId: string) => void;
  /** Replace-navigate to a bare `/repos` (a stale restore). */
  clearConversation: () => void;
}): { showSkeleton: boolean } {
  const [hardCapElapsed, setHardCapElapsed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setHardCapElapsed(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);
  const listSettled = (connected && samplingSettled) || hardCapElapsed;
  const knownChannelIds = useMemo(() => new Set(channelIds), [channelIds]);

  // --- 1. Validate a restored landing -------------------------------------
  const [restored] = useState(() => {
    const entry = consumeRestoredLanding();
    return entry !== null && entry.channelId === selectedId ? entry : null;
  });
  const [restorePending, setRestorePending] = useState<string | null>(
    restored?.channelId ?? null,
  );
  // A restore found stale: never re-remembered while the URL still names it.
  const [rejectedId, setRejectedId] = useState<string | null>(null);
  useEffect(() => {
    if (restorePending === null) {
      return;
    }
    if (selectedId !== restorePending) {
      // The user moved on before validation finished — their choice stands.
      setRestorePending(null);
      return;
    }
    const verdict = restoreVerdict({
      channelId: restorePending,
      storedPubkey: restored?.pubkey ?? null,
      selfPubkey,
      knownChannelIds,
      hiddenDmIds,
      listSettled,
    });
    if (verdict === "wait") {
      return;
    }
    if (verdict === "stale") {
      setRejectedId(restorePending);
      clearLastConversation(lastConversationStorage(), lastConversationScope());
      clearConversation();
    }
    setRestorePending(null);
  }, [
    restored,
    restorePending,
    selectedId,
    selfPubkey,
    knownChannelIds,
    hiddenDmIds,
    listSettled,
    clearConversation,
  ]);

  // --- 3. Remember the conversation being shown ---------------------------
  useEffect(() => {
    if (
      selectedId === undefined ||
      restorePending !== null ||
      selectedId === rejectedId
    ) {
      return;
    }
    saveLastConversation(lastConversationStorage(), lastConversationScope(), {
      channelId: selectedId,
      at: Date.now(),
      pubkey: selfPubkey,
    });
  }, [selectedId, restorePending, rejectedId, selfPubkey]);

  // --- 2. Default conversation (D-025) ------------------------------------
  // Runs at most once per app load: a deep link (?c= / ?view=) or any user
  // selection retires it, so closing a conversation later never bounces
  // anyone back, and a user with zero visible DMs keeps the empty state.
  // There is deliberately NO early-fire on the first sample
  // (first-loaded-wins was the original roulette).
  const handledRef = useRef(false);
  const [landingResolved, setLandingResolved] = useState(false);
  useEffect(() => {
    if (handledRef.current || restorePending !== null) {
      return;
    }
    const decision = decideDefaultConversation({
      handled: false,
      // A rejected restore is not a choice anyone made.
      userAlreadySelected:
        (selectedId !== undefined && selectedId !== rejectedId) ||
        view !== undefined,
      connected,
      channelCount: channelIds.length,
      samplingSettled,
      hardCapElapsed,
      visibleDms,
    });
    if (decision.action === "wait") {
      return;
    }
    handledRef.current = true;
    setLandingResolved(true);
    if (decision.action === "open") {
      openConversation(visibleDms[decision.index].channel.id);
    }
  }, [
    restorePending,
    rejectedId,
    selectedId,
    view,
    connected,
    channelIds.length,
    samplingSettled,
    hardCapElapsed,
    visibleDms,
    openConversation,
  ]);

  const showSkeleton =
    restorePending !== null ||
    (selectedId === undefined
      ? view === undefined && !landingResolved
      : !knownChannelIds.has(selectedId) && !listSettled);
  return { showSkeleton };
}

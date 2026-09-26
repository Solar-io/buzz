import { useEffect, useMemo, useRef, useState } from "react";

import { decideDefaultConversation } from "@/features/dms/lib/defaultConversation";

import {
  clearLastConversation,
  loadLastConversation,
  restoreVerdict,
  saveLastConversation,
} from "./lastConversation.ts";
import {
  consumeRestoredLanding,
  lastConversationScope,
  lastConversationStorage,
} from "./lastConversationScope.ts";

/**
 * Where `/repos` lands (plan item 5). The rule (Sam, 2026-09-26): the app
 * always ends up IN a conversation — it never parks on "Pick a channel"
 * while there is anything to open.
 *
 * 1. The conversation the app opened on — restored by the route's
 *    `beforeLoad` from the last one Sam used, or deep-linked as `?c=` — is
 *    validated against the channel list once that list has really loaded
 *    (the relay's EOSE, not the seed). If it does not exist (deleted, a
 *    fake id, a hidden DM or another identity's restore), it is dropped —
 *    and cleared from storage if it was the stored one — and the landing
 *    falls through to step 2.
 * 2. Default conversation (D-025): the most recently active DM once the DM
 *    sampling window settles (5 s hard cap). Where D-025 would stand down
 *    (several DMs, none with activity; or no DMs), it lands in the first
 *    DM, else the first channel, instead of the empty picker.
 * 3. Every valid selected conversation is remembered for the next load.
 *
 * `showSkeleton` is true while the landing is undecided. The picker renders
 * only when the community genuinely has no conversation at all.
 */
export function useLandingConversation({
  selectedId,
  view,
  connected,
  channelIds,
  samplingSettled,
  channelsLoaded = true,
  visibleDms,
  fallbackChannelIds = [],
  hiddenDmIds,
  selfPubkey,
  webViewOpen = false,
  openConversation,
  clearConversation,
}: {
  selectedId: string | undefined;
  view: string | undefined;
  connected: boolean;
  channelIds: readonly string[];
  samplingSettled: boolean;
  /** The relay answered the channel-list REQ (EOSE) at least once. */
  channelsLoaded?: boolean;
  /** Activity-sorted visible DMs (hidden excluded), as the sidebar lists them. */
  visibleDms: ReadonlyArray<{ lastActivity: number; channel: { id: string } }>;
  /** Non-DM channels in sidebar order: the last-resort landing. */
  fallbackChannelIds?: readonly string[];
  hiddenDmIds: readonly string[];
  selfPubkey: string | null;
  /** A link / Files page is showing — the user already chose something. */
  webViewOpen?: boolean;
  /** Replace-navigate to a conversation (the D-025 pick). */
  openConversation: (channelId: string) => void;
  /** Replace-navigate to a bare `/repos` (an invalid landing id). */
  clearConversation: () => void;
}): { showSkeleton: boolean } {
  const [hardCapElapsed, setHardCapElapsed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setHardCapElapsed(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);
  // The list is a verdict only once the relay has answered for BOTH the
  // channel list and the DM samples; a cold origin with no seed otherwise
  // "settles" on an empty or partial list (the >11 s picker, QA 2026-09-26).
  const listSettled =
    (connected && channelsLoaded && samplingSettled) || hardCapElapsed;
  const knownChannelIds = useMemo(() => new Set(channelIds), [channelIds]);

  // --- 1. Validate the landing id (restored OR deep-linked) ---------------
  const [restored] = useState(() => {
    const entry = consumeRestoredLanding();
    return entry !== null && entry.channelId === selectedId ? entry : null;
  });
  const [pending, setPending] = useState<string | null>(selectedId ?? null);
  // An id found invalid: never remembered, never counted as a user choice.
  const [rejectedId, setRejectedId] = useState<string | null>(null);
  useEffect(() => {
    if (pending === null) {
      return;
    }
    if (selectedId !== pending) {
      // The user moved on before validation finished — their choice stands.
      setPending(null);
      return;
    }
    const isRestore = restored !== null;
    const verdict = restoreVerdict({
      channelId: pending,
      storedPubkey: restored?.pubkey ?? null,
      selfPubkey,
      knownChannelIds,
      // A hidden DM is a stale RESTORE; a deep link to one is deliberate.
      hiddenDmIds: isRestore ? hiddenDmIds : [],
      listSettled,
    });
    if (verdict === "wait") {
      return;
    }
    if (verdict === "stale") {
      setRejectedId(pending);
      const storage = lastConversationStorage();
      const scope = lastConversationScope();
      if (loadLastConversation(storage, scope)?.channelId === pending) {
        clearLastConversation(storage, scope);
      }
      clearConversation();
    }
    setPending(null);
  }, [
    restored,
    pending,
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
      pending !== null ||
      selectedId === rejectedId
    ) {
      return;
    }
    saveLastConversation(lastConversationStorage(), lastConversationScope(), {
      channelId: selectedId,
      at: Date.now(),
      pubkey: selfPubkey,
    });
  }, [selectedId, pending, rejectedId, selfPubkey]);

  // --- 2. Default conversation (D-025 + always-land fallback) -------------
  // Runs at most once per app load: a deep link (?c= / ?view=), an opened
  // web page or any user selection retires it, so closing a conversation
  // later never bounces anyone back. No early-fire on the first sample
  // (first-loaded-wins was the original roulette).
  const handledRef = useRef(false);
  const [landingResolved, setLandingResolved] = useState(false);
  useEffect(() => {
    if (handledRef.current || pending !== null) {
      return;
    }
    const decision = decideDefaultConversation({
      handled: false,
      // A rejected id is not a choice anyone made.
      userAlreadySelected:
        (selectedId !== undefined && selectedId !== rejectedId) ||
        view !== undefined ||
        // Opening a link or Files is a choice too: never yank it away.
        webViewOpen,
      connected,
      channelCount: channelIds.length,
      samplingSettled: samplingSettled && channelsLoaded,
      hardCapElapsed,
      visibleDms,
    });
    if (decision.action === "wait") {
      return;
    }
    if (decision.action === "handled") {
      handledRef.current = true;
      setLandingResolved(true);
      return;
    }
    const target =
      decision.action === "open"
        ? visibleDms[decision.index].channel.id
        : (visibleDms[0]?.channel.id ?? fallbackChannelIds[0] ?? null);
    handledRef.current = true;
    if (target !== null) {
      // The skeleton stays up until the navigation lands (selectedId is then
      // set), so "Pick a channel" never renders for a frame in between.
      openConversation(target);
      return;
    }
    // Genuinely nothing to open: the picker is the honest state.
    setLandingResolved(true);
  }, [
    pending,
    rejectedId,
    selectedId,
    view,
    webViewOpen,
    connected,
    channelIds.length,
    samplingSettled,
    channelsLoaded,
    hardCapElapsed,
    visibleDms,
    fallbackChannelIds,
    openConversation,
  ]);

  const showSkeleton =
    pending !== null ||
    (selectedId === undefined || selectedId === rejectedId
      ? view === undefined && !landingResolved
      : !knownChannelIds.has(selectedId) && !listSettled);
  return { showSkeleton };
}

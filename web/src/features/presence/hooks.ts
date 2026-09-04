import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

import {
  PRESENCE_ACTIVITY_THROTTLE_MS,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_KIND,
  PRESENCE_STATUS_TICK_INTERVAL_MS,
  effectivePresenceStatus,
  mergePresenceEntry,
  preferenceForManualPick,
  presenceEntryFromEvent,
  readPresencePreference,
  resolveAutomaticPresenceStatus,
  writePresencePreference,
  type ObservedPresenceStatus,
  type PresenceEntry,
  type PresencePreference,
  type PresenceStatus,
} from "./lib/presenceStatus.ts";

const EMPTY_PRESENCE: ReadonlyMap<string, PresenceEntry> = new Map();

/**
 * Presence for a set of pubkeys: one author-scoped kind-20001 REQ.
 *
 * Author-scoped (not `#h`-scoped) is what makes this go live: the relay
 * registers a subscription whose filters all lack `#h` as *global*, and
 * kind-20001 carries no `h` tag, so it is fanned out to global subscribers.
 * The relay also synthesizes a snapshot on subscribe, so the map is populated
 * before anybody re-publishes.
 */
export function usePresenceMap(
  pubkeys: readonly string[],
): ReadonlyMap<string, PresenceEntry> {
  const { session } = useRelaySession();
  const [entries, setEntries] =
    useState<ReadonlyMap<string, PresenceEntry>>(EMPTY_PRESENCE);

  // The subscription's identity is the *set*, not the array: a parent that
  // rebuilds an equal array each render must not churn a relay REQ.
  const authors = useMemo(
    () =>
      Array.from(
        new Set(
          pubkeys
            .map((pubkey) => pubkey.trim().toLowerCase())
            .filter((pubkey) => pubkey.length > 0),
        ),
      ).sort(),
    [pubkeys],
  );
  const authorsKey = authors.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `authors` is rebuilt from `authorsKey`, which is the subscription's real identity
  useEffect(() => {
    if (authors.length === 0) {
      setEntries(EMPTY_PRESENCE);
      return;
    }
    setEntries(EMPTY_PRESENCE);
    return session.subscribe(
      { kinds: [PRESENCE_KIND], authors, limit: authors.length },
      {
        onEvent: (event: SignedNostrEvent) => {
          const entry = presenceEntryFromEvent(event);
          if (entry) {
            setEntries((current) => mergePresenceEntry(current, entry));
          }
        },
      },
    );
  }, [session, authorsKey]);

  return entries;
}

/** One pubkey's observed status, or "unknown" until something arrives. */
export function usePresenceStatus(
  pubkey: string | null | undefined,
): ObservedPresenceStatus {
  const subjects = useMemo(() => (pubkey ? [pubkey] : []), [pubkey]);
  const entries = usePresenceMap(subjects);
  if (!pubkey) {
    return "unknown";
  }
  return entries.get(pubkey.toLowerCase())?.status ?? "unknown";
}

/** Publish own presence. Best-effort: presence must never break a page. */
export async function publishPresence(
  session: RelaySession,
  status: PresenceStatus,
): Promise<void> {
  try {
    const event = await signNostrEvent({
      kind: PRESENCE_KIND,
      tags: [],
      content: status,
    });
    await session.publish(event);
  } catch {
    // Signer locked, socket closed, relay refused — all fine to swallow.
  }
}

export interface SelfPresence {
  /** What everyone else sees for you right now. */
  status: PresenceStatus;
  /** The viewer's choice; `auto` means "follow my activity". */
  preference: PresencePreference;
  /** Pick a status. `online` returns to `auto` rather than pinning green. */
  setStatus: (status: PresenceStatus) => void;
}

/**
 * The viewer's own presence: heartbeat, idle detection, and manual override.
 *
 * Three timers, each for a distinct reason:
 *
 * - **Heartbeat** ({@link PRESENCE_HEARTBEAT_INTERVAL_MS}) — the relay's TTL
 *   is 180s. Without this the tab goes offline for everyone else after three
 *   minutes and never returns. This is the bug this hook exists to fix.
 * - **Status tick** — re-derives online/away from the activity clock, so a
 *   user who stops touching the tab goes away without any further input.
 * - **Activity listeners** — throttled, and they write a *ref*, not state.
 *   Bumping state on every keystroke would re-render this hook's host on
 *   every character the user types anywhere in the app; the desktop hit
 *   exactly that and moved to a ref for the same reason.
 */
export function useSelfPresence(
  selfPubkey: string | null | undefined,
): SelfPresence {
  const { session, status: sessionStatus } = useRelaySession();
  const pubkey = selfPubkey?.trim().toLowerCase() ?? "";

  const [preference, setPreference] = useState<PresencePreference>(() =>
    readPresencePreference(safeLocalStorage(), pubkey),
  );
  const lastActivityAtRef = useRef(Date.now());
  const [automatic, setAutomatic] = useState<PresenceStatus>("online");

  // Identity change: re-read that key's preference and restart its clock.
  useEffect(() => {
    setPreference(readPresencePreference(safeLocalStorage(), pubkey));
    lastActivityAtRef.current = Date.now();
    setAutomatic("online");
  }, [pubkey]);

  // Activity: ref write plus a *conditional* state write, so a re-render
  // happens only when online/away actually flips.
  useEffect(() => {
    if (pubkey.length === 0) {
      return;
    }
    let lastRecordedAt = 0;
    const record = () => {
      const now = Date.now();
      if (now - lastRecordedAt < PRESENCE_ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastRecordedAt = now;
      lastActivityAtRef.current = now;
      setAutomatic((current) => (current === "online" ? current : "online"));
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", record, options);
    window.addEventListener("pointermove", record, options);
    window.addEventListener("wheel", record, options);
    window.addEventListener("keydown", record, options);
    window.addEventListener("focus", record);
    return () => {
      window.removeEventListener("pointerdown", record, options);
      window.removeEventListener("pointermove", record, options);
      window.removeEventListener("wheel", record, options);
      window.removeEventListener("keydown", record, options);
      window.removeEventListener("focus", record);
    };
  }, [pubkey]);

  // Status tick: the only thing that can move us to "away".
  useEffect(() => {
    if (pubkey.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      const next = resolveAutomaticPresenceStatus(
        lastActivityAtRef.current,
        Date.now(),
      );
      setAutomatic((current) => (current === next ? current : next));
    }, PRESENCE_STATUS_TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pubkey]);

  const status = effectivePresenceStatus(preference, automatic);

  // Publish on every transition, and on the heartbeat while not invisible.
  // `sessionStatus` is a dependency so the first beat lands as soon as the
  // socket is actually open rather than a minute later.
  const connected = sessionStatus === "open";
  useEffect(() => {
    if (pubkey.length === 0 || !connected) {
      return;
    }
    void publishPresence(session, status);
    if (status === "offline") {
      // Invisible is a single write; there is nothing to keep alive, and the
      // relay's TTL retires it on its own.
      return;
    }
    const timer = window.setInterval(() => {
      void publishPresence(session, status);
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [session, pubkey, status, connected]);

  // Leaving the page: say so, rather than lingering green for up to the TTL.
  // `pagehide` fires on bfcache navigations where `unload` does not.
  useEffect(() => {
    if (pubkey.length === 0) {
      return;
    }
    const onPageHide = () => {
      void publishPresence(session, "offline");
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [session, pubkey]);

  const setStatus = useCallback(
    (next: PresenceStatus) => {
      const nextPreference = preferenceForManualPick(next);
      if (nextPreference === "auto") {
        lastActivityAtRef.current = Date.now();
        setAutomatic("online");
      }
      setPreference(nextPreference);
      writePresencePreference(safeLocalStorage(), pubkey, nextPreference);
    },
    [pubkey],
  );

  return { status, preference, setStatus };
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage blocked by policy — the hook degrades to "auto" every load.
    return null;
  }
}

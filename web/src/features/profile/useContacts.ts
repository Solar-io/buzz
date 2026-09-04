import { useCallback, useEffect, useMemo, useState } from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

import {
  KIND_CONTACT_LIST,
  buildContactListEvent,
  isFollowing,
  pickLatestContactList,
  type ContactListEvent,
} from "./lib/contactList.ts";

export interface ContactListState {
  /** The newest kind-3 seen for the viewer, or null when they have none. */
  event: ContactListEvent | null;
  /**
   * True once the read has settled (an event arrived, or the relay sent EOSE
   * with none). Every write is gated on this — see `buildContactListEvent`.
   */
  loaded: boolean;
}

/**
 * The viewer's own follow list.
 *
 * Kept as one subscription for the whole session's worth of profile cards
 * rather than one per card: kind 3 is replaceable and viewer-scoped, so every
 * card is asking the same question.
 */
export function useOwnContactList(
  selfPubkey: string | null | undefined,
): ContactListState {
  const { session } = useRelaySession();
  const [state, setState] = useState<ContactListState>({
    event: null,
    loaded: false,
  });

  useEffect(() => {
    if (!selfPubkey) {
      setState({ event: null, loaded: false });
      return;
    }
    setState({ event: null, loaded: false });
    let newest: ContactListEvent | null = null;
    return session.subscribe(
      { kinds: [KIND_CONTACT_LIST], authors: [selfPubkey], limit: 1 },
      {
        onEvent: (event: SignedNostrEvent) => {
          newest = pickLatestContactList(newest, event);
          setState({ event: newest, loaded: true });
        },
        onEose: () => {
          // EOSE with nothing is a genuinely empty list — the one state that
          // makes a first follow safe.
          setState((current) =>
            current.loaded ? current : { event: null, loaded: true },
          );
        },
      },
    );
  }, [session, selfPubkey]);

  return state;
}

export interface FollowState {
  following: boolean;
  /** False until the list has been read; every control stays disabled. */
  ready: boolean;
  toggle: () => Promise<void>;
  pending: boolean;
}

/**
 * Follow / unfollow one person.
 *
 * The published event is the *whole* rebuilt contact list, which is what
 * kind 3 means. The state is optimistic only in the pending flag: the list
 * itself updates when the relay echoes the replaceable event back, so a
 * rejected publish cannot leave the UI claiming a follow that did not happen.
 */
export function useFollow(
  contacts: ContactListState,
  selfPubkey: string | null | undefined,
  targetPubkey: string,
): FollowState {
  const { session } = useRelaySession();
  const [pending, setPending] = useState(false);

  const following = useMemo(
    () => isFollowing(contacts.event, targetPubkey),
    [contacts.event, targetPubkey],
  );

  const toggle = useCallback(async () => {
    if (!selfPubkey || pending) {
      return;
    }
    setPending(true);
    try {
      const template = buildContactListEvent({
        previous: contacts.event,
        loaded: contacts.loaded,
        pubkey: targetPubkey,
        follow: !following,
      });
      const event = await signNostrEvent(template);
      const result = await session.publish(event);
      if (!result.ok) {
        throw new Error(result.message || "The relay rejected the change.");
      }
    } finally {
      setPending(false);
    }
  }, [
    contacts.event,
    contacts.loaded,
    following,
    pending,
    selfPubkey,
    session,
    targetPubkey,
  ]);

  return {
    following,
    ready: contacts.loaded && Boolean(selfPubkey),
    toggle,
    pending,
  };
}

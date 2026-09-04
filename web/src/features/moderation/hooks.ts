import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import type { NostrFilter } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import {
  channelRoleFromAdminsEvent,
  communityRoleFromMembershipEvent,
  KIND_CHANNEL_ADMINS,
  KIND_RELAY_MEMBERSHIP_LIST,
  moderationCapability,
  type ModerationCapability,
  NO_MODERATION_CAPABILITY,
} from "./lib/capability.ts";
import {
  buildBanEvent,
  buildKickEvent,
  buildRemoveMessageEvent,
  buildTimeoutEvent,
  buildUnbanEvent,
  buildUntimeoutEvent,
} from "./lib/moderationCommands.ts";
import type { EventTemplate, ReportInput } from "./lib/reportEvent.ts";
import { buildReportEvent } from "./lib/reportEvent.ts";
import type {
  CommunityRestriction,
  RawRestriction,
} from "./lib/restrictions.ts";
import { restrictionFromRow } from "./lib/restrictions.ts";
import { latestEvent, subscribeLatestEvent } from "./lib/sharedLatestEvent.ts";
import { isTimeoutActive, parseTimeoutRejection } from "./lib/timeout.ts";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";

const MEMBERSHIP_KEY = "relay-membership";

/**
 * The viewer's own pubkey.
 *
 * Was resolved once per mount and memoized at module scope, on the reasoning
 * that "the answer cannot change without a page reload". It can: `ownPubkey()`
 * reads module state `initKeyStore()` fills in asynchronously, so a null
 * resolved early was cached permanently for every message row — and signing
 * out and back in as someone else kept the previous account's key.
 */
export function useSelfPubkey(): string | null {
  return useOwnPubkey();
}

function useSharedEvent(
  key: string | null,
  filter: () => NostrFilter,
): SignedNostrEvent | null {
  const { session } = useRelaySession();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter is rebuilt from `key`, which is the real identity of the subscription
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (key === null) {
        return () => {};
      }
      return subscribeLatestEvent(session, key, filter(), onChange);
    },
    [session, key],
  );
  const getSnapshot = useCallback(
    () => (key === null ? null : latestEvent(session, key)),
    [session, key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The community's NIP-43 membership snapshot (kind:13534), or null. */
export function useRelayMembershipEvent(): SignedNostrEvent | null {
  return useSharedEvent(MEMBERSHIP_KEY, () => ({
    kinds: [KIND_RELAY_MEMBERSHIP_LIST],
    limit: 1,
  }));
}

/** The channel's NIP-29 admin snapshot (kind:39001) for `channelId`, or null. */
export function useChannelAdminsEvent(
  channelId: string | null | undefined,
): SignedNostrEvent | null {
  const key = channelId ? `channel-admins:${channelId}` : null;
  return useSharedEvent(key, () => ({
    kinds: [KIND_CHANNEL_ADMINS],
    "#d": [channelId as string],
    limit: 1,
  }));
}

/**
 * What the viewer may do to one message's author, gated on the relay's own
 * two authorities. Returns {@link NO_MODERATION_CAPABILITY} until both the
 * viewer's key and the relevant snapshots have arrived — the gate fails closed
 * while loading, so controls never flash in and then vanish.
 */
export function useModerationCapability(input: {
  channelId: string | null | undefined;
  authorPubkey: string | null | undefined;
}): ModerationCapability {
  const selfPubkey = useSelfPubkey();
  const membershipEvent = useRelayMembershipEvent();
  const adminsEvent = useChannelAdminsEvent(input.channelId);

  return useMemo(() => {
    if (!selfPubkey || !input.authorPubkey) {
      return NO_MODERATION_CAPABILITY;
    }
    return moderationCapability({
      actorCommunityRole: communityRoleFromMembershipEvent(
        membershipEvent,
        selfPubkey,
      ),
      actorChannelRole: channelRoleFromAdminsEvent(
        adminsEvent,
        selfPubkey,
        input.channelId,
      ),
      targetCommunityRole: communityRoleFromMembershipEvent(
        membershipEvent,
        input.authorPubkey,
      ),
      targetIsSelf:
        selfPubkey.toLowerCase() === input.authorPubkey.toLowerCase(),
    });
  }, [
    selfPubkey,
    membershipEvent,
    adminsEvent,
    input.channelId,
    input.authorPubkey,
  ]);
}

/**
 * Active bans and timeouts for the whole community, so the menu can offer
 * "Lift ban" instead of a second "Ban" against someone already banned.
 *
 * Mod-gated: `enabled` must be the viewer's own ban/timeout capability, or
 * every ordinary member fires a request the relay answers 403. Read failures
 * resolve to "no restrictions", which fails toward showing the *apply* action —
 * the relay still guard-rails a redundant command, whereas a phantom "Lift
 * ban" would offer a moderator an action against nothing.
 */
export function useCommunityRestrictions(
  enabled: boolean,
): CommunityRestriction[] {
  const query = useQuery({
    enabled,
    queryKey: ["moderation", "restricted"],
    staleTime: 15_000,
    retry: false,
    queryFn: async (): Promise<CommunityRestriction[]> => {
      const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/moderation/restricted`;
      const authorization = await makeNip98AuthHeader(url, "GET");
      const response = await fetch(url, { headers: { authorization } });
      if (!response.ok) {
        throw new Error(`Moderation read failed (${response.status})`);
      }
      const rows = (await response.json()) as RawRestriction[];
      return Array.isArray(rows) ? rows.map(restrictionFromRow) : [];
    },
  });
  return query.data ?? EMPTY_RESTRICTIONS;
}

const EMPTY_RESTRICTIONS: CommunityRestriction[] = [];

/**
 * Sign and publish one moderation command, surfacing the relay's own rejection
 * text. The relay's `OK false` messages are client-safe by contract
 * (`invalid:` / `restricted:` prefixes), so showing them beats a generic
 * failure — "an admin cannot ban or time out a community owner" is exactly
 * what the moderator needs to read.
 */
async function publishTemplate(
  session: ReturnType<typeof useRelaySession>["session"],
  template: EventTemplate,
): Promise<void> {
  const event = await signNostrEvent(template);
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(result.message || "The relay rejected the request.");
  }
}

export interface ModerationActions {
  submitReport: (input: ReportInput) => Promise<void>;
  banAuthor: (pubkey: string) => Promise<void>;
  unbanAuthor: (pubkey: string) => Promise<void>;
  timeoutAuthor: (input: {
    pubkey: string;
    expiresAt: number;
  }) => Promise<void>;
  untimeoutAuthor: (pubkey: string) => Promise<void>;
  kickAuthor: (input: { channelId: string; pubkey: string }) => Promise<void>;
  removeMessage: (input: {
    channelId: string;
    targetEventId: string;
    publicReason?: string;
  }) => Promise<void>;
}

/** Every moderation write a message row can perform, bound to the live session. */
export function useModerationActions(): ModerationActions {
  const { session } = useRelaySession();
  return useMemo(
    () => ({
      submitReport: (input) =>
        publishTemplate(session, buildReportEvent(input)),
      banAuthor: (pubkey) =>
        publishTemplate(session, buildBanEvent({ pubkey })),
      unbanAuthor: (pubkey) =>
        publishTemplate(session, buildUnbanEvent(pubkey)),
      timeoutAuthor: (input) =>
        publishTemplate(session, buildTimeoutEvent(input)),
      untimeoutAuthor: (pubkey) =>
        publishTemplate(session, buildUntimeoutEvent(pubkey)),
      kickAuthor: (input) => publishTemplate(session, buildKickEvent(input)),
      removeMessage: (input) =>
        publishTemplate(session, buildRemoveMessageEvent(input)),
    }),
    [session],
  );
}

export interface ComposerTimeoutState {
  /** True while the viewer is known to be timed out. */
  timedOut: boolean;
  /** Expiry in epoch ms, or null when the relay gave no parseable timestamp. */
  expiresAtMs: number | null;
  /**
   * Feed every send result here. A timeout refusal arms the banner; any other
   * result (success included) clears it, so a lifted timeout un-blocks on the
   * member's next successful send rather than needing a reload.
   */
  noteSendResult: (result: { ok: boolean; message: string }) => void;
}

/**
 * Composer-side timeout state, learned reactively from send rejections.
 *
 * Reactive is not a shortcut: `/moderation/restricted` is the only restriction
 * read and it is mod-gated, so a timed-out member is precisely the person
 * forbidden to read their own row. The relay's `OK false` text is the channel.
 */
export function useComposerTimeout(): ComposerTimeoutState {
  const [expiresAtMs, setExpiresAtMs] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const noteSendResult = useCallback(
    (result: { ok: boolean; message: string }) => {
      const rejection = result.ok
        ? null
        : parseTimeoutRejection(result.message);
      if (rejection) {
        setExpiresAtMs(rejection.expiresAtMs);
        setTimedOut(true);
        return;
      }
      setTimedOut(false);
      setExpiresAtMs(null);
    },
    [],
  );

  // Self-clearing: once the known expiry passes there is nothing left to say,
  // so the banner retires without waiting for another send attempt.
  useEffect(() => {
    if (!timedOut || expiresAtMs === null) {
      return;
    }
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(false), remaining);
    return () => window.clearTimeout(timer);
  }, [timedOut, expiresAtMs]);

  return useMemo(
    () => ({
      timedOut: timedOut && isTimeoutActive(expiresAtMs),
      expiresAtMs,
      noteSendResult,
    }),
    [timedOut, expiresAtMs, noteSendResult],
  );
}

export type { CommunityRestriction, ModerationCapability };

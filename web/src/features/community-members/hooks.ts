import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";

import type { EventTemplate } from "./lib/memberCommands.ts";
import {
  buildAddMemberEvent,
  buildChangeRoleEvent,
  buildRemoveMemberEvent,
} from "./lib/memberCommands.ts";
import {
  EMPTY_ROSTER,
  KIND_RELAY_MEMBERSHIP_LIST,
  roleOf,
  rosterFromEvent,
  type CommunityRole,
  type CommunityRoster,
} from "./lib/members.ts";
import {
  foldRosterIntoLedger,
  joinAlertStorageKey,
  readJoinAlertLedger,
  writeJoinAlertLedger,
} from "./lib/joinAlerts.ts";
import {
  mintInviteBody,
  mintedInviteFromResponse,
  validateInviteOptions,
  type MintInviteOptions,
  type MintedInvite,
} from "./lib/inviteOptions.ts";

const INVITE_TIMEOUT_MS = 15_000;

/**
 * The community roster, live.
 *
 * One REQ for the community's single kind-13534. It is replaceable and
 * relay-signed, so "newest by `created_at`" is the whole reduction — and the
 * relay republishes it on every membership change, which is what makes an
 * add or a remove show up in this list without a refetch.
 *
 * Deliberately its own subscription rather than the shared one in
 * `features/moderation/lib/sharedLatestEvent.ts`: that cache drops its
 * snapshot with its last consumer *because* a stale role read is exactly what
 * a moderation gate must not have, and this screen is mounted alone.
 */
export function useCommunityRoster(): CommunityRoster {
  const { session } = useRelaySession();
  const [roster, setRoster] = useState<CommunityRoster>(EMPTY_ROSTER);
  // Newest `created_at` seen, in a ref: it gates whether an arrival wins, and
  // it must never cause a render of its own. Reducing it inside a setState
  // updater would make the decision run twice under StrictMode.
  const newestRef = useRef(0);

  useEffect(() => {
    newestRef.current = 0;
    return session.subscribe(
      { kinds: [KIND_RELAY_MEMBERSHIP_LIST], limit: 1 },
      {
        onEvent: (event: SignedNostrEvent) => {
          if (event.created_at < newestRef.current) {
            return;
          }
          newestRef.current = event.created_at;
          setRoster(rosterFromEvent(event));
        },
        onEose: () => {
          // An open relay publishes no snapshot at all. Mark the read as
          // settled so the UI can say "this community has no roster" instead
          // of spinning forever.
          setRoster((current) =>
            current.loaded ? current : { ...current, loaded: true },
          );
        },
      },
    );
  }, [session]);

  return roster;
}

/** The viewer's own community role, or null when unlisted. */
export function useMyCommunityRole(
  roster: CommunityRoster,
  selfPubkey: string | null | undefined,
): CommunityRole | null {
  return useMemo(() => roleOf(roster, selfPubkey), [roster, selfPubkey]);
}

export interface MemberActions {
  addMember: (input: {
    pubkey: string;
    role: Exclude<CommunityRole, "owner">;
  }) => Promise<void>;
  removeMember: (pubkey: string) => Promise<void>;
  changeRole: (input: {
    pubkey: string;
    role: Exclude<CommunityRole, "owner">;
  }) => Promise<void>;
}

/**
 * Sign and publish one relay-admin command, surfacing the relay's own
 * rejection text.
 *
 * The refusal strings are client-safe by contract ("an admin can only remove
 * members", "cannot change your own role"), and showing them beats a generic
 * failure: they name the rule that was broken.
 */
async function publishCommand(
  session: ReturnType<typeof useRelaySession>["session"],
  template: EventTemplate,
): Promise<void> {
  const event = await signNostrEvent(template);
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(result.message || "The relay rejected the request.");
  }
}

export function useMemberActions(): MemberActions {
  const { session } = useRelaySession();
  return useMemo(
    () => ({
      addMember: (input) => publishCommand(session, buildAddMemberEvent(input)),
      removeMember: (pubkey) =>
        publishCommand(session, buildRemoveMemberEvent(pubkey)),
      changeRole: (input) =>
        publishCommand(session, buildChangeRoleEvent(input)),
    }),
    [session],
  );
}

/**
 * Mint an invite link — `POST /api/invites`, NIP-98 signed.
 *
 * HTTP rather than an event because that is where the relay put it: the code
 * is minted into `relay_invites` and returned in the response, which no
 * fire-and-forget event publish could carry back. The relay re-checks the
 * owner/admin role itself, so this is defence in depth, not the only gate.
 */
export async function mintInvite(
  options: MintInviteOptions,
): Promise<MintedInvite> {
  const invalid = validateInviteOptions(options);
  if (invalid) {
    throw new Error(invalid);
  }
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/api/invites`;
  const body = mintInviteBody(options);
  // The relay requires a `payload` tag carrying sha256(body) for signed POSTs
  // and checks the `u` tag against the exact URL, so both are finalized before
  // signing.
  const authorization = await makeNip98AuthHeader(url, "POST", { body });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(INVITE_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof json.error === "string" ? json.error : `HTTP ${response.status}`,
    );
  }
  const minted = mintedInviteFromResponse(json);
  if (!minted) {
    throw new Error("The relay returned an invite without a code.");
  }
  return minted;
}

/**
 * Pubkeys that have joined since this browser last looked.
 *
 * Owner/admin-facing: a plain member has no roster screen to act on it. The
 * ledger is folded on every snapshot and persisted immediately, so a reload
 * does not re-announce the same arrivals.
 */
export function useNewJoiners(
  roster: CommunityRoster,
  selfPubkey: string | null | undefined,
  enabled: boolean,
): { joined: string[]; dismiss: () => void } {
  const [joined, setJoined] = useState<string[]>([]);
  const rosterKey = roster.members.map((member) => member.pubkey).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `roster` is folded by `rosterKey`, which is its content identity
  useEffect(() => {
    if (!enabled || !roster.loaded || !selfPubkey) {
      return;
    }
    const storage = safeLocalStorage();
    const key = joinAlertStorageKey(relayWsUrl(), selfPubkey);
    const ledger = readJoinAlertLedger(storage, key);
    const fold = foldRosterIntoLedger(
      ledger,
      roster.members.map((member) => member.pubkey),
      selfPubkey,
    );
    writeJoinAlertLedger(storage, key, fold.ledger);
    if (fold.joined.length > 0) {
      setJoined((current) => [
        ...current,
        ...fold.joined.filter((pubkey) => !current.includes(pubkey)),
      ]);
    }
  }, [enabled, roster.loaded, rosterKey, selfPubkey]);

  const dismiss = useCallback(() => setJoined([]), []);
  return useMemo(() => ({ joined, dismiss }), [joined, dismiss]);
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

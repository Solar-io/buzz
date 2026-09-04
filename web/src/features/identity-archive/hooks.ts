/**
 * NIP-IA in the browser.
 *
 * The desktop routes all of this through Rust (`commands/identity_archive.rs`).
 * Nothing there needed a native capability: the snapshot is a relay query, the
 * requests are signed events, and the NIP-OA gate is a SHA-256 plus a BIP-340
 * verify. So this is a genuine port rather than an approximation — the one
 * substitution is `@noble/curves` for the `secp256k1` the Rust side gets from
 * `nostr`.
 *
 * The relay's advertised `self` pubkey comes from its NIP-11 document, which is
 * a public unauthenticated read. Everything fails open (nobody archived) when
 * that read, the query, or the signature check does not come back clean.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8Encoder } from "nostr-tools/utils";
import { getEventHash } from "nostr-tools/pure";

import { communityRoleFromMembershipEvent } from "@/features/moderation/lib/capability.ts";
import { useRelayMembershipEvent } from "@/features/moderation/hooks";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { queryEvents } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { ownPubkey, signNostrEvent } from "@/shared/lib/nostr-signer";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";

import {
  buildArchiveRequest,
  buildUnarchiveRequest,
  canArchive,
  KIND_IA_ARCHIVED_LIST,
  makeArchivedPredicate,
  snapshotArchivedPubkeys,
  type ArchiveRequestInput,
} from "./lib/identityArchiveEvents.ts";
import { resolveOaOwner, type OwnerOfAgent } from "./lib/nipOa.ts";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify a signed event's id and signature, the browser equivalent of the
 * desktop's `verify_id() && verify_signature()` defence-in-depth on the
 * snapshot. `verifyEvent` from nostr-tools caches its verdict on the event
 * object, which is exactly what we do NOT want for a security check on an
 * object that arrived over the wire, so the two steps are done explicitly.
 */
function verifySignedEvent(event: SignedNostrEvent): boolean {
  try {
    if (getEventHash(event) !== event.id) return false;
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    );
  } catch {
    return false;
  }
}

/** BIP-340 verify over SHA-256 of the NIP-OA preimage. */
function verifyOwnerAttestation(input: {
  preimage: string;
  ownerPubkeyHex: string;
  signatureHex: string;
}): boolean {
  try {
    return schnorr.verify(
      hexToBytes(input.signatureHex),
      sha256(utf8Encoder.encode(input.preimage)),
      hexToBytes(input.ownerPubkeyHex),
    );
  } catch {
    return false;
  }
}

/**
 * The relay's own signing key, from its NIP-11 document's `self` field.
 * Cached per page: it identifies the relay, and it does not change under a
 * running tab.
 */
let relaySelfPromise: Promise<string | null> | null = null;

export function fetchRelaySelf(): Promise<string | null> {
  relaySelfPromise ??= (async () => {
    try {
      const response = await fetch(relayHttpBaseUrl(), {
        headers: { Accept: "application/nostr+json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      const document = (await response.json()) as Record<string, unknown>;
      const self = document.self;
      return typeof self === "string" && /^[0-9a-f]{64}$/i.test(self)
        ? self.toLowerCase()
        : null;
    } catch {
      return null;
    }
  })();
  return relaySelfPromise;
}

export interface ArchivedIdentities {
  archived: string[];
  loading: boolean;
  /** True when the relay advertises no `self` — archival cannot be trusted. */
  unavailable: boolean;
  refresh: () => void;
}

/**
 * The relay's latest kind-13535 snapshot.
 *
 * Author-scoped to the advertised signer in the FILTER, and re-checked against
 * it after the fact — the same belt-and-braces the desktop uses, because the
 * client must reject wrongly signed relay-authoritative state even when the
 * filter should have made that impossible.
 */
export function useArchivedIdentities(): ArchivedIdentities {
  const [archived, setArchived] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);

  /*
   * `nonce` is the refresh handle, not a value the effect reads. Archiving is
   * asynchronous on the relay — it regenerates the 13535 snapshot after
   * accepting a request — so a caller must be able to force a re-read once its
   * publish returns.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh handle; see above
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const relaySelf = await fetchRelaySelf();
      if (cancelled) return;
      if (!relaySelf) {
        setUnavailable(true);
        setArchived([]);
        setLoading(false);
        return;
      }
      setUnavailable(false);
      try {
        const events = await queryEvents(relayWsUrl(), {
          authors: [relaySelf],
          kinds: [KIND_IA_ARCHIVED_LIST],
          limit: 1,
        });
        if (cancelled) return;
        const newest = [...events].sort(
          (left, right) => right.created_at - left.created_at,
        )[0];
        setArchived(
          snapshotArchivedPubkeys(newest ?? null, relaySelf, (candidate) =>
            verifySignedEvent(candidate as SignedNostrEvent),
          ),
        );
      } catch {
        // Query failed — fail open rather than guessing.
        if (!cancelled) setArchived([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { archived, loading, unavailable, refresh };
}

/** Self-exempt fold predicate for discovery surfaces. */
export function useIsArchivedPredicate(): (pubkey: string) => boolean {
  const { archived } = useArchivedIdentities();
  const [self, setSelf] = useState<string | null>(null);
  useEffect(() => {
    void ownPubkey().then(setSelf);
  }, []);
  return useMemo(() => makeArchivedPredicate(archived, self), [archived, self]);
}

/** The verified NIP-OA owner of `pubkey`, or null. */
export function useOaOwner(pubkey: string | null): OwnerOfAgent | null {
  const [owner, setOwner] = useState<OwnerOfAgent | null>(null);

  useEffect(() => {
    const target = pubkey?.trim().toLowerCase() ?? "";
    if (!/^[0-9a-f]{64}$/.test(target)) {
      setOwner(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const viewer = await ownPubkey();
        const events = await queryEvents(relayWsUrl(), {
          kinds: [0],
          authors: [target],
          limit: 1,
        });
        if (cancelled) return;
        const profile = events[0] ?? null;
        setOwner(
          profile
            ? resolveOaOwner(profile, viewer, verifyOwnerAttestation)
            : null,
        );
      } catch {
        if (!cancelled) setOwner(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  return owner;
}

export interface IdentityArchiveActions {
  /** Render guard only — the relay re-verifies authority on submit. */
  canArchive: boolean;
  /** undefined while the snapshot loads, so flair can be deferred. */
  isArchived: boolean | undefined;
  isPending: boolean;
  archive: (options?: {
    reason?: string;
    replacedBy?: string;
    content?: string;
  }) => Promise<string | null>;
  unarchive: (options?: {
    reason?: string;
    content?: string;
  }) => Promise<string | null>;
}

/**
 * Everything one pubkey's archive controls need. Both mutators return an error
 * string or null, never throw.
 */
export function useIdentityArchive(
  pubkey: string | null,
): IdentityArchiveActions {
  const { session } = useRelaySession();
  const { archived, loading, refresh } = useArchivedIdentities();
  const membershipEvent = useRelayMembershipEvent();
  const [self, setSelf] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    void ownPubkey().then(setSelf);
  }, []);

  const target = pubkey?.trim().toLowerCase() ?? "";
  const isSelf = self !== null && target === self.toLowerCase();
  // Skip the kind:0 lookup when viewing yourself — the owner gate is for
  // archiving *other* identities you own.
  const oaOwner = useOaOwner(isSelf || target.length === 0 ? null : target);

  const communityRole = useMemo(
    () =>
      self ? communityRoleFromMembershipEvent(membershipEvent, self) : null,
    [membershipEvent, self],
  );

  const submit = useCallback(
    async (
      build: (input: ArchiveRequestInput) =>
        | { event: { kind: number; tags: string[][]; content: string } }
        | {
            error: string;
          },
      options: { reason?: string; replacedBy?: string; content?: string },
    ): Promise<string | null> => {
      if (target.length === 0) return "No identity selected.";
      setIsPending(true);
      try {
        const built = build({
          targetPubkey: target,
          content: options.content,
          reason: options.reason,
          replacedBy: options.replacedBy,
          // The owner consent path forwards the target's own attestation.
          ...(oaOwner?.isMe ? { auth: oaOwner.tag } : {}),
        });
        if ("error" in built) return built.error;
        const signed = await signNostrEvent(built.event);
        const result = await session.publish(signed);
        if (!result.ok) return result.message || "The relay refused it.";
        // The relay regenerates the snapshot asynchronously; re-read so the
        // flair self-heals without a page reload.
        refresh();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "Request failed.";
      } finally {
        setIsPending(false);
      }
    },
    [oaOwner, refresh, session, target],
  );

  return {
    canArchive: canArchive({
      targetPubkey: target,
      selfPubkey: self,
      communityRole,
      isOaOwnerOfTarget: oaOwner?.isMe === true,
    }),
    isArchived: loading
      ? undefined
      : archived.includes(target) && target.length > 0,
    isPending,
    archive: (options = {}) => submit(buildArchiveRequest, options),
    unarchive: (options = {}) => submit(buildUnarchiveRequest, options),
  };
}

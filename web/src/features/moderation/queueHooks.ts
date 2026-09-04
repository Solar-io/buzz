import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  type ChannelRole,
  type CommunityRole,
} from "./lib/capability.ts";
import {
  buildBanEvent,
  buildKickEvent,
  buildRemoveMessageEvent,
  buildTimeoutEvent,
} from "./lib/moderationCommands.ts";
import type { EventTemplate } from "./lib/reportEvent.ts";
import { buildResolveReportEvent } from "./lib/resolveReportEvent.ts";
import type {
  ModerationAuditAction,
  ModerationReport,
  RawModerationAction,
  RawModerationReport,
} from "./lib/queueRows.ts";
import {
  auditActionFromRow,
  isForbiddenStatus,
  reportFromRow,
} from "./lib/queueRows.ts";
import type { ResolutionAction } from "./lib/queueAuthority.ts";
import { useRelayMembershipEvent, useSelfPubkey } from "./hooks.ts";

/**
 * The moderator-only reads and writes the queue needs, on top of the
 * per-message moderation surface in `hooks.ts`.
 *
 * Three sources, and they are genuinely different transports:
 *
 *  - the report and audit rows are NIP-98-authed HTTP GETs, because the
 *    `moderation_reports` / `moderation_actions` tables are not events and
 *    have no WebSocket equivalent;
 *  - the viewer's community role and the reported author's come from the
 *    kind-13534 NIP-43 membership snapshot over the socket;
 *  - the viewer's role in each *reported channel* comes from that channel's
 *    kind-39001 admin snapshot, also over the socket — and it is needed
 *    because the relay's 9005/9001 arms read channel roles, never community
 *    ones (see `lib/queueAuthority.ts` for the full arm-by-arm mapping).
 */

/** Cap the queue read. The relay clamps to 500 regardless. */
const REPORT_PAGE_LIMIT = 200;
/** Cap the audit read — it only feeds the "prior actions" banner. */
const AUDIT_PAGE_LIMIT = 200;

/**
 * A moderation read that failed, carrying the HTTP status so the caller can
 * tell "you are not a moderator" (403, the relay's own gate) apart from a real
 * failure. A generic Error would collapse the two and show a broken panel to
 * every ordinary member who opened the pane.
 */
export class ModerationReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ModerationReadError";
    this.status = status;
  }
}

/**
 * Fetch one `/moderation/*` path.
 *
 * The NIP-98 `u` tag must equal the *full* request URL including the query
 * string: `authorize_moderation_read` rebuilds `path?query` from the raw query
 * and verifies the signature against that. So the URL is finalized before it
 * is signed, and nothing appends to it afterwards.
 */
async function moderationGet<T>(pathWithQuery: string): Promise<T> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}${pathWithQuery}`;
  const authorization = await makeNip98AuthHeader(url, "GET");
  const response = await fetch(url, { headers: { authorization } });
  if (!response.ok) {
    throw new ModerationReadError(
      response.status,
      isForbiddenStatus(response.status)
        ? "Moderator access is required to read this community's queue."
        : `The relay refused the moderation read (${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

export interface ModerationRead<T> {
  rows: T[];
  loading: boolean;
  /** The relay answered 403 — the viewer is not a community moderator. */
  forbidden: boolean;
  /** Any other failure, already phrased for display. */
  error: string | null;
  refetch: () => void;
}

const EMPTY_REPORTS: ModerationReport[] = [];
const EMPTY_ACTIONS: ModerationAuditAction[] = [];

/**
 * Phrase a failed read for display.
 *
 * Only a {@link ModerationReadError} carries text worth showing: it is built
 * here from a status the relay chose, so it says something a moderator can act
 * on. Everything else is a thrown JavaScript error whose message describes an
 * implementation detail — a same-origin deploy that serves the SPA shell for an
 * unknown path makes `response.json()` throw `Unexpected token '<', "<!doctype
 * "... is not valid JSON`, and that string rendered verbatim in the pane during
 * the browser pass. Those become one sentence instead.
 */
function readState<Row>(
  query: UseQueryResult<Row[], unknown>,
  fallback: Row[],
): ModerationRead<Row> {
  const error = query.error;
  const forbidden =
    error instanceof ModerationReadError && isForbiddenStatus(error.status);
  const message =
    error instanceof ModerationReadError
      ? error.message
      : error
        ? "The moderation read failed. The relay may be unreachable."
        : null;
  return {
    rows: query.data ?? fallback,
    loading: query.isLoading,
    forbidden,
    error: forbidden ? null : message,
    refetch: () => {
      void query.refetch();
    },
  };
}

/** Open reports for this community (`GET /moderation/reports?status=open`). */
export function useModerationReports(
  enabled = true,
): ModerationRead<ModerationReport> {
  const query = useQuery({
    enabled,
    queryKey: ["moderation", "reports", "open"],
    retry: false,
    staleTime: 10_000,
    queryFn: async () => {
      const rows = await moderationGet<RawModerationReport[]>(
        `/moderation/reports?limit=${REPORT_PAGE_LIMIT}&status=open`,
      );
      return Array.isArray(rows) ? rows.map(reportFromRow) : [];
    },
  });
  return readState(query, EMPTY_REPORTS);
}

/** The audit log (`GET /moderation/audit`), newest first. */
export function useModerationAudit(
  enabled = true,
): ModerationRead<ModerationAuditAction> {
  const query = useQuery({
    enabled,
    queryKey: ["moderation", "audit"],
    retry: false,
    staleTime: 10_000,
    queryFn: async () => {
      const rows = await moderationGet<RawModerationAction[]>(
        `/moderation/audit?limit=${AUDIT_PAGE_LIMIT}`,
      );
      return Array.isArray(rows) ? rows.map(auditActionFromRow) : [];
    },
  });
  return readState(query, EMPTY_ACTIONS);
}

/**
 * Split a list of filter values into REQ-sized chunks.
 *
 * The relay caps explicit `#h` values at 128 per REQ and answers CLOSED past
 * that rather than truncating, so a queue showing more channels than that
 * would silently lose its whole role read. `#d` and `ids` are not bound by
 * that constant today, but they are bound by the same reasoning — one REQ per
 * chunk is cheap, and a CLOSED subscription is invisible.
 */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

const FILTER_VALUE_CHUNK = 64;

/**
 * Collect events for a set of filters into a map keyed by an extractor.
 *
 * One subscription per chunk, all torn down together. The map is replaced
 * (never mutated) so `useMemo` consumers see a new reference exactly when a
 * new event arrives.
 */
function useEventMap(
  filters: NostrFilter[],
  keyOf: (event: SignedNostrEvent) => string | null,
  /** Identity of `filters`, which is a fresh array on every render. */
  signature: string,
): Map<string, SignedNostrEvent> {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<Map<string, SignedNostrEvent>>(
    () => new Map(),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands in for `filters`, which is a fresh array each render
  useEffect(() => {
    setEvents(new Map());
    if (filters.length === 0) {
      return;
    }
    const unsubscribes = filters.map((filter) =>
      session.subscribe(filter, {
        onEvent: (event) => {
          const key = keyOf(event);
          if (key === null) {
            return;
          }
          setEvents((previous) => {
            const existing = previous.get(key);
            // Both kinds this backs are replaceable: newest wins, ties keep
            // the incumbent so a re-sent snapshot is a no-op rather than a
            // render.
            if (existing && existing.created_at >= event.created_at) {
              return previous;
            }
            const next = new Map(previous);
            next.set(key, event);
            return next;
          });
        },
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, signature, keyOf]);

  return events;
}

/**
 * The viewer's role in each of `channelIds`, read from those channels' NIP-29
 * kind-39001 admin snapshots.
 *
 * A channel with no entry maps to `null`, which is the fail-closed answer: the
 * relay publishes 39001 with owner/admin rows only, so "absent" means "not a
 * channel moderator" — and so does "the snapshot has not arrived yet", which
 * is why the queue hides the channel-scoped resolutions rather than showing
 * them optimistically.
 */
export function useViewerChannelRoles(
  channelIds: readonly string[],
): Map<string, ChannelRole | null> {
  const selfPubkey = useSelfPubkey();
  const ids = useMemo(
    () => [...new Set(channelIds.filter((id) => id.length > 0))].sort(),
    [channelIds],
  );
  const signature = ids.join(",");
  const filters = useMemo(
    () =>
      chunk(ids, FILTER_VALUE_CHUNK).map((group) => ({
        kinds: [KIND_CHANNEL_ADMINS],
        "#d": group,
        limit: group.length,
      })),
    [ids],
  );
  const keyOf = useCallback(
    (event: SignedNostrEvent) =>
      event.tags.find((tag) => tag[0] === "d")?.[1] ?? null,
    [],
  );
  const snapshots = useEventMap(filters, keyOf, signature);

  return useMemo(() => {
    const roles = new Map<string, ChannelRole | null>();
    for (const id of ids) {
      roles.set(
        id,
        channelRoleFromAdminsEvent(snapshots.get(id) ?? null, selfPubkey, id),
      );
    }
    return roles;
  }, [ids, snapshots, selfPubkey]);
}

/**
 * The reported events themselves, by id.
 *
 * A report row carries the reported event's id and channel but not its author:
 * ingest drops the reporter's `p` tag into `moderation_reports.reporter_pubkey`
 * and the target's author is never stored. Every member-directed enforcement
 * (ban, timeout, kick) needs that author, and the only trustworthy source is
 * the event's own signer — so the queue reads the events back.
 *
 * The filter is deliberately kindless. `p_gated_filters_authorized` exempts a
 * filter that names `ids` — "knowing the id implies authorization" — but only
 * while the filter does not explicitly name a p-gated kind, and a report can
 * point at any kind at all.
 */
export function useReportedEvents(
  eventIds: readonly string[],
): Map<string, SignedNostrEvent> {
  const ids = useMemo(
    () => [...new Set(eventIds.filter((id) => id.length > 0))].sort(),
    [eventIds],
  );
  const signature = ids.join(",");
  const filters = useMemo(
    () =>
      chunk(ids, FILTER_VALUE_CHUNK).map((group) => ({
        ids: group,
        limit: group.length,
      })),
    [ids],
  );
  const keyOf = useCallback((event: SignedNostrEvent) => event.id, []);
  return useEventMap(filters, keyOf, signature);
}

/** One pubkey's community role from the shared kind-13534 snapshot. */
export function useCommunityRoleOf(
  pubkey: string | null | undefined,
): CommunityRole | null {
  const membership = useRelayMembershipEvent();
  return useMemo(
    () => communityRoleFromMembershipEvent(membership, pubkey),
    [membership, pubkey],
  );
}

/** The viewer's own community role. */
export function useViewerCommunityRole(): CommunityRole | null {
  return useCommunityRoleOf(useSelfPubkey());
}

/** What actually happened when a resolution was submitted. */
export interface ResolutionOutcome {
  /** The enforcement event landed (or there was none to send). */
  enforced: boolean;
  /** How many open reports were closed. */
  resolved: number;
  /** How many were attempted. */
  attempted: number;
  /** The relay's own refusal text, when something was refused. */
  message: string | null;
}

export interface ResolveInput {
  action: ResolutionAction;
  /** Every open report about this target — all get closed together. */
  reportEventIds: readonly string[];
  /** The reported event, for `delete`. */
  targetEventId?: string | null;
  /** The channel the reported event lives in, for `delete` and `kick`. */
  channelId?: string | null;
  /** The reported author, for `ban`, `timeout` and `kick`. */
  authorPubkey?: string | null;
  /** Timeout expiry, epoch seconds — required by the relay for a timeout. */
  timeoutExpiresAt?: number;
  /** Moderator note; reporter-readable (see resolveReportEvent.ts). */
  reason?: string;
}

async function publish(
  session: ReturnType<typeof useRelaySession>["session"],
  template: EventTemplate,
): Promise<void> {
  const event = await signNostrEvent(template);
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(result.message || "The relay rejected the request.");
  }
}

/**
 * Compose the enforcement event a resolution promises, if any.
 *
 * Throws rather than returning a flag: the caller must not send the resolve
 * when this fails, and an ignored boolean is how "reviewed and acted on" gets
 * DM'd to a reporter for an action the relay refused.
 */
async function enforce(
  session: ReturnType<typeof useRelaySession>["session"],
  input: ResolveInput,
): Promise<void> {
  switch (input.action) {
    case "delete": {
      if (!input.channelId || !input.targetEventId) {
        throw new Error("This report has no message to remove.");
      }
      await publish(
        session,
        buildRemoveMessageEvent({
          channelId: input.channelId,
          targetEventId: input.targetEventId,
          publicReason: input.reason?.trim() || "Removed by a moderator",
        }),
      );
      return;
    }
    case "kick": {
      if (!input.channelId || !input.authorPubkey) {
        throw new Error("This report has no channel member to remove.");
      }
      await publish(
        session,
        buildKickEvent({
          channelId: input.channelId,
          pubkey: input.authorPubkey,
        }),
      );
      return;
    }
    case "ban": {
      if (!input.authorPubkey) {
        throw new Error("The reported author could not be resolved.");
      }
      await publish(
        session,
        buildBanEvent({
          pubkey: input.authorPubkey,
          reason: input.reason?.trim() || undefined,
        }),
      );
      return;
    }
    case "timeout": {
      if (!input.authorPubkey) {
        throw new Error("The reported author could not be resolved.");
      }
      if (!input.timeoutExpiresAt) {
        throw new Error("A timeout needs a duration.");
      }
      await publish(
        session,
        buildTimeoutEvent({
          pubkey: input.authorPubkey,
          expiresAt: input.timeoutExpiresAt,
          reason: input.reason?.trim() || undefined,
        }),
      );
      return;
    }
    case "escalate":
    case "dismiss":
      // Decision-only: the resolve IS the whole action.
      return;
  }
}

/**
 * Run one resolution: enforce first, then close every open report about the
 * target.
 *
 * The ordering is the honesty guarantee. A resolve writes an audit row, closes
 * the report, and DMs the reporter that it was "reviewed and acted on"; if the
 * enforcement it names had failed, that DM would be a lie and the audit row
 * would record a decision nothing carried out. So enforcement failure aborts
 * before any resolve is sent, and the reports stay open and retryable.
 *
 * The reverse gap is real but benign and is reported rather than hidden: the
 * enforcement can land and a resolve still fail (a second moderator closed the
 * same report first — the relay's `WHERE status='open'` is the arbiter). The
 * outcome then says the action was applied and how many reports were left
 * open, instead of claiming a clean resolution.
 */
export function useResolveReport(): (
  input: ResolveInput,
) => Promise<ResolutionOutcome> {
  const { session } = useRelaySession();
  return useCallback(
    async (input: ResolveInput): Promise<ResolutionOutcome> => {
      const attempted = input.reportEventIds.length;
      try {
        await enforce(session, input);
      } catch (error) {
        return {
          enforced: false,
          resolved: 0,
          attempted,
          message:
            error instanceof Error
              ? error.message
              : "The relay refused the action.",
        };
      }

      let resolved = 0;
      let message: string | null = null;
      for (const reportEventId of input.reportEventIds) {
        try {
          await publish(
            session,
            buildResolveReportEvent({
              reportEventId,
              action: input.action,
              reason: input.reason,
            }),
          );
          resolved += 1;
        } catch (error) {
          message ??=
            error instanceof Error
              ? error.message
              : "The relay refused the resolution.";
        }
      }
      return { enforced: true, resolved, attempted, message };
    },
    [session],
  );
}

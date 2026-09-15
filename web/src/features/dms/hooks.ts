import { useEffect, useMemo, useRef, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import type { ChannelSummary } from "@/features/channels/lib/channelFromEvent.ts";
import {
  dmActivityFromEvents,
  compareDmRecency,
  dmActivityFilterBatches,
  DM_ACTIVITY_KIND,
  type DmLastMessage,
} from "./lib/dmActivity.ts";
import { extractOpenDmChannelId } from "./lib/dmInput.ts";

export interface DmSummary {
  channel: ChannelSummary;
  /** Last kind:9 timestamp seen for this DM (0 = never sampled). */
  lastActivity: number;
  /** Newest sampled message (author + excerpt) for the sidebar preview row. */
  lastMessage: DmLastMessage | null;
}

/**
 * Split the channel list into DMs (relay `t` tag) with activity ordering.
 * One subscription's worth of recency (see useDmActivity) drives the sort;
 * channels with no sampled activity fall back to metadata recency.
 */
export function useDms(channels: ChannelSummary[]): {
  dms: DmSummary[];
  channelsWithoutDms: ChannelSummary[];
  /** True when every per-DM sampling batch hit EOSE (or no DMs exist). */
  dmSamplingSettled: boolean;
} {
  const dmIds = useMemo(
    () => channels.filter((c) => c.type === "dm").map((c) => c.id),
    [channels],
  );
  const { activity, settled } = useDmActivity(dmIds);
  const dms = useMemo(() => {
    const list = channels
      .filter((c) => c.type === "dm")
      .map((channel) => ({
        channel,
        lastActivity: activity.get(channel.id)?.created_at ?? 0,
        lastMessage: activity.get(channel.id) ?? null,
      }));
    // Most recent ACTIVITY first: a real message beats a metadata touch,
    // and only never-messaged DMs fall back to their creation time
    // (Sam 2026-09-02: "they should sort based on most recent activity").
    list.sort((a, b) =>
      compareDmRecency(
        {
          lastActivity: a.lastActivity,
          updatedAt: a.channel.updatedAt,
          name: a.channel.name,
        },
        {
          lastActivity: b.lastActivity,
          updatedAt: b.channel.updatedAt,
          name: b.channel.name,
        },
      ),
    );
    return list;
  }, [channels, activity]);
  const channelsWithoutDms = useMemo(
    () => channels.filter((c) => c.type !== "dm"),
    [channels],
  );
  return { dms, channelsWithoutDms, dmSamplingSettled: settled };
}

/**
 * Recency sample across every known DM: ONE kind:9 subscription with an
 * #h filter over all DM ids. Resubscribes only when the DM id SET changes
 * (joined key), so a growing DM list stays cheap. Also reports when the
 * durable window has settled (EOSE across every batch) — the default-open
 * pick waits on that signal so a cold start does not decide before the
 * samples exist (D-025 round 3).
 */
function useDmActivity(dmIds: string[]): {
  activity: Map<string, DmLastMessage>;
  settled: boolean;
} {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<SignedNostrEvent[]>([]);
  const [settled, setSettled] = useState(false);
  /**
   * Durable-only window. The phantom-DM incident: the sidebar consumed
   * kind 9s from channel-scoped subscriptions (which legitimately include
   * cross-channel traffic the app also subscribes to) as DM ordering keys
   * and previews, so conversations surfaced rows their own transcripts
   * never contained. The wire was later verified clean end to end
   * (2026-09-15 frame-level capture with literal sub prefixes: per-DM
   * filters never received foreign events; the earlier "relay fan-out"
   * claim was an instrument artifact and is retracted) — the defect was
   * app-side consumption, which this window contains. Events accepted
   * AFTER the stored window closes (EOSE across every batch) are ignored:
   * a preview must never promise a message the channel's own history will
   * not show. Cost, taken deliberately: a genuinely new DM message does
   * not re-sort the sidebar until the next reload or DM-set change —
   * recency freshness trades for truthfulness.
   */
  const durableWindowClosedRef = useRef(false);
  // Pubkeys are comma-free, so the join is a lossless set key.
  const idsKey = useMemo(
    () => Array.from(new Set(dmIds)).sort().join(","),
    [dmIds],
  );
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (ids.length === 0) {
      setEvents([]);
      setSettled(true);
      return;
    }
    durableWindowClosedRef.current = false;
    setEvents([]);
    setSettled(false);
    // Exact per-DM sampling (a shared limit starves quiet DMs) packed into
    // multi-filter REQs so mount does not fire one REQ per DM — the burst
    // tripped the relay's concurrency limiter and sibling subs (profiles!)
    // got refused, blanking sidebar names/photos.
    const batches = dmActivityFilterBatches(ids);
    let awaitingEose = batches.length;
    const unsubscribes = batches.map((filters) =>
      session.subscribe(filters, {
        onEvent: (event) => {
          if (durableWindowClosedRef.current) return;
          if (event.kind !== DM_ACTIVITY_KIND) return;
          setEvents((previous) => {
            const id = event.tags.find((tag) => tag[0] === "h")?.[1];
            if (!id) {
              return previous;
            }
            const existing = previous.find(
              (candidate) =>
                candidate.tags.find((tag) => tag[0] === "h")?.[1] === id,
            );
            if (existing && existing.created_at >= event.created_at) {
              return previous;
            }
            return [
              ...previous.filter(
                (candidate) =>
                  candidate.tags.find((tag) => tag[0] === "h")?.[1] !== id,
              ),
              event,
            ];
          });
        },
        onEose: () => {
          awaitingEose -= 1;
          if (awaitingEose <= 0) {
            durableWindowClosedRef.current = true;
            setSettled(true);
          }
        },
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, idsKey]);
  const activity = useMemo(() => dmActivityFromEvents(events), [events]);
  return { activity, settled };
}

export interface OpenDmResult {
  ok: boolean;
  /** Relay-derived channel id; null when the relay accepted but named nothing. */
  channelId: string | null;
  message: string;
}

/**
 * Open (or re-open — this also un-hides) a DM: sign kind 41010 with one p
 * tag per other participant, no d tag (buzz-sdk build_dm_open shape; the
 * relay derives the channel id from the participant set and returns it in
 * the OK message).
 */
export async function openDm(
  session: RelaySession,
  otherPubkeys: string[],
): Promise<OpenDmResult> {
  const event = await signNostrEvent({
    kind: 41010,
    tags: otherPubkeys.map((pubkey) => ["p", pubkey]),
    content: "",
  });
  const result = await session.publish(event);
  return {
    ok: result.ok,
    channelId: result.ok ? extractOpenDmChannelId(result.message) : null,
    message: result.message,
  };
}

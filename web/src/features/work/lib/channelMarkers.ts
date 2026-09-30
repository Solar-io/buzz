/**
 * Per-channel status for the sidebar's markers (Main artboard): a coral hex
 * and a count where something in the channel NEEDS the viewer, else a
 * pulsing amber hex where agents are RUNNING there.
 *
 * Derived from the Everywhere work feed, so a row and its marker can never
 * disagree. What counts:
 *
 * - needs: approvals, asks and mentions in the channel. Feedback (reminders)
 *   does NOT mark a channel — it is something the viewer filed for later, and
 *   a channel would otherwise sit coral for as long as a reminder is overdue.
 * - running: live and reaction-derived turns. A stalled or lost turn is not
 *   running; it is listed in Work, where it says so.
 *
 * Rows without a channel (heartbeat turns, channel-less approvals) mark
 * nothing.
 */

import type { NeedRow, RunRow } from "./workTypes.ts";

export interface ChannelMarker {
  needs: number;
  running: number;
}

export type ChannelMarkers = ReadonlyMap<string, ChannelMarker>;

export function channelMarkers(feed: {
  needs: readonly Pick<NeedRow, "kind" | "channelId">[];
  running: readonly Pick<RunRow, "state" | "channelId">[];
}): Map<string, ChannelMarker> {
  const markers = new Map<string, ChannelMarker>();
  const at = (channelId: string): ChannelMarker => {
    let marker = markers.get(channelId);
    if (!marker) {
      marker = { needs: 0, running: 0 };
      markers.set(channelId, marker);
    }
    return marker;
  };
  for (const row of feed.needs) {
    if (row.channelId !== null && row.kind !== "feedback") {
      at(row.channelId).needs += 1;
    }
  }
  for (const row of feed.running) {
    if (
      row.channelId !== null &&
      (row.state === "live" || row.state === "reacting")
    ) {
      at(row.channelId).running += 1;
    }
  }
  return markers;
}

/**
 * A stable identity for a marker map: the sidebar re-ranks and re-renders
 * when its props change, and the feed re-derives several times a second.
 */
export function markersKey(markers: ChannelMarkers): string {
  return [...markers.entries()]
    .map(([id, marker]) => `${id}:${marker.needs}:${marker.running}`)
    .sort()
    .join("|");
}

/** What the sidebar row and the ⌘K hint say for a marker, or null. */
export function markerLabel(marker: ChannelMarker | undefined): string | null {
  if (!marker) {
    return null;
  }
  if (marker.needs > 0) {
    return marker.needs === 1 ? "1 needs you" : `${marker.needs} need you`;
  }
  if (marker.running > 0) {
    return marker.running === 1
      ? "1 agent working"
      : `${marker.running} agents working`;
  }
  return null;
}

import type { ChannelSummary } from "@/features/channels/useChannels";

/**
 * Small, pure copy helpers for the Work rows. Ages are compact ("now", "6m",
 * "3h", "2d") because they sit in a 42px column; clocks follow the viewer's
 * locale.
 */

export function shortAge(atS: number, nowS: number): string {
  const seconds = Math.max(0, nowS - atS);
  if (seconds < 60) {
    return "now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** "12h overdue" / "6d overdue". */
export function overdueLabel(overdueBy: number): string {
  const hours = Math.floor(overdueBy / 3600);
  if (hours < 1) {
    return `${Math.max(1, Math.floor(overdueBy / 60))}m overdue`;
  }
  return hours < 48
    ? `${hours}h overdue`
    : `${Math.floor(hours / 24)}d overdue`;
}

/** "due 3:10 PM" / "due Tue". */
export function dueLabel(atS: number, nowS: number): string {
  const date = new Date(atS * 1000);
  const sameDay = new Date(nowS * 1000).toDateString() === date.toDateString();
  return sameDay
    ? `due ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : `due ${date.toLocaleDateString([], { weekday: "short" })}`;
}

/** "1m 40s" / "12m" / "1h 05m" — elapsed for running rows. */
export function elapsedLabel(startedAt: number, nowS: number): string {
  const total = Math.max(0, Math.floor(nowS - startedAt));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes >= 10) {
    return `${minutes}m`;
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function clockLabel(atS: number): string {
  return new Date(atS * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "#engineering", "DM", or "" when the channel is unknown. */
export function channelLabel(
  channelId: string | null,
  channels: readonly ChannelSummary[] | undefined,
): string {
  if (!channelId) {
    return "";
  }
  const channel = channels?.find((candidate) => candidate.id === channelId);
  if (!channel) {
    return "";
  }
  return channel.type === "dm" ? "DM" : `#${channel.name}`;
}

/** Join the non-empty parts with the canvas's middle dot. */
export function metaLine(...parts: Array<string | null | undefined | false>) {
  return parts.filter(Boolean).join(" · ");
}

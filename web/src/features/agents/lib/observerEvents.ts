/**
 * Agent observer frames — the "thinking" feed the desktop client shows in a
 * DM's right panel. Frames are kind 24200, NIP-44 v2 encrypted by the agent
 * to the OWNER (buzz-core observer.rs), so only the owner's key decrypts
 * them; other viewers see the locked count.
 */

export interface ObserverFrame {
  id: string;
  createdAt: number;
  /** Monotonic process-local sequence from the agent. */
  seq: number;
  /** RFC3339 UTC timestamp. */
  timestamp: string;
  /** Observer event kind, e.g. "turn_started" / "acp_read". */
  kind: string;
  /** Buzz channel UUID for channel-scoped events. */
  channelId: string | null;
  /** Raw or semantic payload. */
  payload: unknown;
}

export interface ObserverFeed {
  frames: ObserverFrame[];
  /** Frames whose content could not be decrypted with the local key. */
  lockedCount: number;
}

/** Best-effort one-line summary of an observer payload for the panel. */
export function observerFrameSummary(frame: ObserverFrame): string {
  if (frame.payload && typeof frame.payload === "object") {
    const record = frame.payload as Record<string, unknown>;
    for (const key of ["text", "message", "title", "summary", "name"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, 160);
      }
    }
  }
  if (typeof frame.payload === "string" && frame.payload.trim()) {
    return frame.payload.trim().slice(0, 160);
  }
  try {
    return JSON.stringify(frame.payload).slice(0, 160);
  } catch {
    return "";
  }
}

/** "turn_started" → "Turn started" for display. */
export function observerKindLabel(kind: string): string {
  return kind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

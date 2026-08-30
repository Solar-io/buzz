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

/*
 * Curated transcript — the desktop's agentSessionTranscript treatment in
 * miniature. Raw observer frames are RPC noise (acp_read batches et al);
 * what humans want from the "thinking" pane is:
 *   - agent_thought_chunk streams → Thinking text (chunks accumulate per
 *     message id)
 *   - tool_call / tool_call_update → one titled tool row with a status
 *   - turn_started → a divider
 * Everything else is suppressed (counted, not shown).
 */

export type TranscriptEntry =
  | {
      type: "thought";
      id: string;
      at: number;
      text: string;
    }
  | {
      type: "tool";
      id: string;
      at: number;
      title: string;
      status: string;
    }
  | {
      type: "turn";
      id: string;
      at: number;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** ACP content blocks → plain text (desktop extractContentText, condensed). */
function blockText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(blockText).join("\n");
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (record.content !== undefined) {
    return blockText(record.content);
  }
  if (typeof record.rawOutput === "string") {
    return record.rawOutput;
  }
  return "";
}

function toolTitle(update: Record<string, unknown>): string {
  return (
    asString(update.title) ??
    asString(update.toolName) ??
    asString(update.kind) ??
    asString(update.name) ??
    "Tool call"
  );
}

export function transcriptFromFrames(frames: ObserverFrame[]): {
  entries: TranscriptEntry[];
  suppressed: number;
} {
  const byId = new Map<string, TranscriptEntry>();
  const order: string[] = [];
  let suppressed = 0;
  const upsert = (entry: TranscriptEntry) => {
    const existing = byId.get(entry.id);
    if (existing) {
      byId.set(entry.id, { ...existing, ...entry });
    } else {
      byId.set(entry.id, entry);
      order.push(entry.id);
    }
  };
  for (const frame of frames) {
    if (frame.kind === "turn_started") {
      upsert({ type: "turn", id: `turn:${frame.id}`, at: frame.createdAt });
      continue;
    }
    if (frame.kind !== "acp_read") {
      suppressed += 1;
      continue;
    }
    const payload = asRecord(frame.payload);
    if (!payload || asString(payload.method) !== "session/update") {
      suppressed += 1;
      continue;
    }
    const params = asRecord(payload.params);
    const update = asRecord(params?.update);
    if (!update) {
      suppressed += 1;
      continue;
    }
    const updateType = asString(update.sessionUpdate);
    const key =
      asString(update.messageId) ?? frame.channelId ?? String(frame.seq);
    if (updateType === "agent_thought_chunk") {
      const id = `thought:${key}`;
      const text = blockText(update.content);
      const existing = byId.get(id);
      upsert({
        type: "thought",
        id,
        at: frame.createdAt,
        text:
          existing && existing.type === "thought" ? existing.text + text : text,
      });
    } else if (
      updateType === "tool_call" ||
      updateType === "tool_call_update"
    ) {
      const id = `tool:${asString(update.toolCallId) ?? frame.id}`;
      upsert({
        type: "tool",
        id,
        at: frame.createdAt,
        title: toolTitle(update),
        status:
          asString(update.status) ??
          (updateType === "tool_call_update" ? "completed" : "executing"),
      });
    } else {
      // user echoes, assistant message chunks (they land in the chat), RPC
      // housekeeping — noise for this pane.
      suppressed += 1;
    }
  }
  return {
    entries: order.map((id) => byId.get(id) as TranscriptEntry),
    suppressed,
  };
}

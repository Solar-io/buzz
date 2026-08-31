/**
 * Agent observer frames — the "thinking" feed the desktop client shows in a
 * DM's right panel. Frames are kind 24200, NIP-44 v2 encrypted by the agent
 * to the OWNER (buzz-core observer.rs), so only the owner's key decrypts
 * them; other viewers see the locked count.
 *
 * Field names mirror the desktop's canonical ObserverEvent (and the Rust
 * serde camelCase rename) exactly; a @desktop type-only import was tried as
 * a compile-time drift guard but the image's web-builder stage copies only
 * web/ + admin-web/, so the alias cannot ride in container builds. Re-check
 * against desktop/src/features/agents/ui/agentSessionTypes.ts when touching
 * this shape.
 */
export interface ObserverFrame {
  /** Relay event id (the encrypted envelope's id). */
  id: string;
  /** Envelope created_at, unix seconds. */
  createdAt: number;
  /** Monotonic process-local sequence from the agent. */
  seq: number;
  /** RFC3339 UTC timestamp. */
  timestamp: string;
  /** Observer event kind, e.g. "turn_started" / "acp_read". */
  kind: string;
  agentIndex: number | null;
  /** Buzz channel UUID for channel-scoped events. */
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  startedAt?: string | null;
  /** Raw or semantic payload. */
  payload: unknown;
}

/** Parse a decrypted observer payload; null on malformed JSON or kind. */
export function parseObserverPayload(raw: string): ObserverFrame | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ObserverFrame>;
    if (typeof parsed.kind !== "string") {
      return null;
    }
    return {
      id: "",
      createdAt: 0,
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      kind: parsed.kind,
      agentIndex:
        typeof parsed.agentIndex === "number" ? parsed.agentIndex : null,
      channelId: typeof parsed.channelId === "string" ? parsed.channelId : null,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      turnId: typeof parsed.turnId === "string" ? parsed.turnId : null,
      startedAt: parsed.startedAt ?? null,
      payload: parsed.payload ?? null,
    };
  } catch {
    return null;
  }
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
      /** Collapsed run of routine tool calls — desktop "Ran N tool calls". */
      type: "toolBurst";
      id: string;
      at: number;
      count: number;
    }
  | {
      /** Turn-scoped usage from usage_update — "Tokens: used/size ($cost)". */
      type: "usage";
      id: string;
      at: number;
      text: string;
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
  // The store appends frames in ARRIVAL order; retained history replays
  // newest-first from the relay, so an unsorted walk renders the transcript
  // backwards and "scroll to bottom" lands on the OLDEST turn. Walk in
  // chronological (createdAt, seq) order instead — stable for equal stamps.
  const sorted = [...frames].sort(
    (a, b) => a.createdAt - b.createdAt || a.seq - b.seq,
  );
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
  for (const frame of sorted) {
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
    } else if (updateType === "usage_update") {
      // Desktop parity: "Usage Tokens: 652259/1000000 ($310.5979 USD)".
      const used = typeof update.used === "number" ? update.used : null;
      const size = typeof update.size === "number" ? update.size : null;
      if (used !== null && size !== null) {
        const cost = asRecord(update.cost);
        const amount = typeof cost?.amount === "number" ? cost.amount : null;
        const currency = asString(cost?.currency);
        const costStr =
          amount !== null && currency
            ? ` ($${amount.toFixed(4)} ${currency})`
            : "";
        upsert({
          type: "usage",
          id: `usage:${frame.channelId ?? ""}:${frame.turnId ?? key}`,
          at: frame.createdAt,
          text: `Usage Tokens: ${used}/${size}${costStr}`,
        });
      } else {
        suppressed += 1;
      }
    } else {
      // user echoes, assistant message chunks (they land in the chat), RPC
      // housekeeping — noise for this pane.
      suppressed += 1;
    }
  }
  return {
    entries: collapseToolBursts(
      order.map((id) => byId.get(id) as TranscriptEntry),
    ),
    suppressed,
  };
}

/**
 * Collapse runs of CONSECUTIVE completed tool rows into one
 * "Ran N tool calls" summary (the desktop's agentSessionTranscriptGrouping
 * burst pass, condensed): raw per-tool titles like "Terminal pending" are
 * noise at this altitude. An executing tool stays visible on its own so the
 * current step is always readable.
 */
function collapseToolBursts(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let run: TranscriptEntry[] = [];
  const flush = () => {
    if (run.length === 1) {
      out.push(run[0]);
    } else if (run.length > 1) {
      out.push({
        type: "toolBurst",
        id: `burst:${run[0].id}`,
        at: run[0].at,
        count: run.length,
      });
    }
    run = [];
  };
  for (const entry of entries) {
    if (entry.type === "tool" && entry.status === "completed") {
      run.push(entry);
      continue;
    }
    flush();
    out.push(entry);
  }
  flush();
  return out;
}

export interface AgentWorkingState {
  working: boolean;
  /** Turn start (unix seconds) when working. */
  startedAt: number | null;
}

/** Freshness window: a turn with no frames for this long reads as stalled. */
const WORKING_STALE_SECONDS = 180;

/**
 * "Received and working" indicator. Turn boundaries:
 * - START: the newest turn_started frame newer than the agent's last chat
 *   reply — or, when turn_started was filtered/paced away, the FIRST frame
 *   after the last reply (sticky by construction: the earliest evidence, not
 *   the latest — a moving start would reset the timer on every tool call).
 * - END: the agent's kind-9 message landing in the channel (newer than the
 *   turn start), or three minutes of silence.
 */
export function agentWorkingState(
  frames: ObserverFrame[],
  lastAgentReplyAt: number,
  nowSeconds: number,
): AgentWorkingState {
  let turnStartedAt: number | null = null;
  let firstEvidenceAt: number | null = null;
  let lastFrameAt = 0;
  for (const frame of frames) {
    if (frame.createdAt > lastAgentReplyAt) {
      if (firstEvidenceAt === null || frame.createdAt < firstEvidenceAt) {
        firstEvidenceAt = frame.createdAt;
      }
      if (
        frame.kind === "turn_started" &&
        frame.createdAt > (turnStartedAt ?? 0)
      ) {
        turnStartedAt = frame.createdAt;
      }
    }
    if (frame.createdAt > lastFrameAt) {
      lastFrameAt = frame.createdAt;
    }
  }
  const startedAt = turnStartedAt ?? firstEvidenceAt;
  if (startedAt === null || lastFrameAt <= lastAgentReplyAt) {
    return { working: false, startedAt: null };
  }
  if (nowSeconds - lastFrameAt > WORKING_STALE_SECONDS) {
    return { working: false, startedAt: null };
  }
  return { working: true, startedAt };
}

/** Sidebar heuristic: agent produced frames within the freshness window. */
export function agentRecentlyActive(
  frames: ObserverFrame[],
  nowSeconds: number,
): boolean {
  let lastFrameAt = 0;
  for (const frame of frames) {
    if (frame.createdAt > lastFrameAt) {
      lastFrameAt = frame.createdAt;
    }
  }
  return lastFrameAt > 0 && nowSeconds - lastFrameAt <= WORKING_STALE_SECONDS;
}

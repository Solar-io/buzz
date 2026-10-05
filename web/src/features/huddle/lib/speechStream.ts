/**
 * Streamed agent speech in a huddle — the pure half (plan
 * VOICE_STREAMED_REPLIES_2026-10-04 §3.3, §3.5).
 *
 * On a `[voice]` turn the harness publishes the agent's reply sentence by
 * sentence as EPHEMERAL kind-24820 segments, then ONE ordinary kind:9 with
 * the full text, tagged with the same stream id:
 *
 *   segment: kind 24820, content = segment text (may be "" on the done marker)
 *            ["h", channel] ["buzz-speech", stream_id, seq, offset]
 *            ["e", trigger, "", "reply"]?   ["done", total_chars]? (last only)
 *   final:   kind 9, content = full text
 *            ["h", channel] ["buzz-speech", stream_id, segments, total_chars]
 *
 * `offset` is the segment's UTF-16 offset into the final text, so
 * `final.slice(offset)` is exact in JS.
 *
 * {@link createSpeechStreamTracker} decides, per event, what this browser
 * should say NOW: segments in order, each once; a final only for the part
 * nobody has spoken yet; nothing after a barge-in cut. Ordering is by `seq`
 * (a missing seq is a gap); offsets are used only to cut the final's tail.
 * Ordering by seq rather than by contiguous offsets keeps whitespace the
 * harness inserts between segments (tool boundaries) from reading as a gap.
 *
 * No browser globals, no timers: time comes in through `now`, and the hook
 * calls {@link SpeechStreamTracker.poll} on an interval for gap skips and
 * idle closes.
 */

/** Ephemeral speech segment kind (buzz-core `KIND_AGENT_SPEECH_SEGMENT`). */
export const AGENT_SPEECH_SEGMENT_KIND = 24820;
/** The tag naming a stream on segments and on the final kind:9. */
export const SPEECH_STREAM_TAG = "buzz-speech";
/** Client switch (§3.5.5): "false" / "off" / "0" turns streamed replies off. */
export const STREAMED_REPLIES_STORAGE_KEY = "buzz.voice.streamedReplies";

/** Hold a missing segment this long before skipping it. */
export const SPEECH_GAP_HOLD_MS = 3_000;
/** An open stream with no done marker closes after this much silence. */
export const SPEECH_IDLE_CLOSE_MS = 90_000;
/** An untagged reply this soon after the agent's stream may be its CLI copy. */
export const SPEECH_DUPLICATE_WINDOW_MS = 20_000;
/** Word overlap at or above which an untagged reply counts as that copy. */
export const SPEECH_DUPLICATE_OVERLAP = 0.6;
/** Ended streams are forgotten this long after their last activity. */
const ENDED_RETENTION_MS = 5 * 60_000;

/**
 * Is the streamed-replies client switch on? Default ON; a missing or
 * unreadable storage reads as on.
 */
export function streamedRepliesEnabled(
  storage?: Pick<Storage, "getItem"> | null,
): boolean {
  let raw: string | null = null;
  try {
    // `window.localStorage`, not the bare global: the getter itself can
    // throw (privacy modes), and node's own global differs from a page's.
    const store =
      storage !== undefined
        ? storage
        : typeof window === "undefined"
          ? null
          : window.localStorage;
    raw = store?.getItem(STREAMED_REPLIES_STORAGE_KEY) ?? null;
  } catch {
    return true;
  }
  if (raw === null) return true;
  const value = raw.trim().toLowerCase();
  return !(value === "false" || value === "off" || value === "0");
}

export interface SpeechStreamEventLike {
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
}

export interface ParsedSegment {
  streamId: string;
  seq: number;
  offset: number;
  /** `total_chars` from the `done` tag; null unless this is the last event. */
  done: number | null;
  /** The triggering `[voice]` event id from the `e` tag, if present. */
  triggerId: string | null;
}

function nonNegativeInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Decode a kind-24820 segment, or null when it is not a well-formed one. */
export function parseSpeechSegment(
  event: SpeechStreamEventLike,
): ParsedSegment | null {
  if (event.kind !== AGENT_SPEECH_SEGMENT_KIND) return null;
  const tag = event.tags.find((t) => t[0] === SPEECH_STREAM_TAG);
  if (!tag?.[1]) return null;
  const seq = nonNegativeInt(tag[2]);
  const offset = nonNegativeInt(tag[3]);
  if (seq === null || offset === null) return null;
  const doneTag = event.tags.find((t) => t[0] === "done");
  const done = doneTag ? nonNegativeInt(doneTag[1]) : null;
  const eTag = event.tags.find((t) => t[0] === "e" && typeof t[1] === "string");
  return {
    streamId: tag[1],
    seq,
    offset,
    done,
    triggerId: eTag?.[1] ?? null,
  };
}

/** The stream id a final kind:9 carries, or null for an untagged message. */
export function speechStreamIdOfFinal(
  event: SpeechStreamEventLike,
): string | null {
  const tag = event.tags.find((t) => t[0] === SPEECH_STREAM_TAG);
  return tag?.[1] ? tag[1] : null;
}

/**
 * Is this segment a huddle agent's, in this channel, and not ours? The same
 * gates `classifySpeakableAgentText` applies to messages, minus the
 * non-empty rule: the done marker is legitimately empty. FAIL-CLOSED on
 * membership, like messages.
 */
export function isAgentSpeechSegment(
  event: SpeechStreamEventLike,
  agentPubkeys: ReadonlySet<string>,
  selfPubkey: string | null,
  channelId: string,
): boolean {
  if (event.kind !== AGENT_SPEECH_SEGMENT_KIND) return false;
  if (!event.tags.some((t) => t[0] === "h" && t[1] === channelId)) {
    return false;
  }
  const author = event.pubkey.toLowerCase();
  if (!agentPubkeys.has(author)) return false;
  return selfPubkey === null || author !== selfPubkey.toLowerCase();
}

/** The ["e", id] a reply points at, for latency correlation. */
export function speechTriggerId(event: SpeechStreamEventLike): string | null {
  const tag = event.tags.find((t) => t[0] === "e" && typeof t[1] === "string");
  return tag?.[1] ?? null;
}

export interface StreamUpdate {
  /** `${agentPubkeyLower}:${streamId}` — the hook's queue key. */
  key: string;
  agentPubkey: string;
  /** True the first time this stream is seen. */
  isNew: boolean;
  /** Text to speak now, in order. */
  speak: string[];
  /** The stream is over: close its queue once `speak` is pushed. */
  ended: boolean;
  /** The segment's `e` tag (first segment only matters). */
  triggerId: string | null;
}

export interface FinalDecision {
  key: string;
  /** What to speak: the whole message, the unspoken tail, or nothing. */
  text: string | null;
  /** True when the stream was open here: push into its queue and close it. */
  streamOpen: boolean;
}

export interface SpeechStreamTracker {
  /** A kind-24820 segment. Null when malformed or for a cut/ended stream. */
  onSegment(event: SpeechStreamEventLike): StreamUpdate | null;
  /** A kind:9 carrying a `buzz-speech` tag. Null when it carries none. */
  onFinal(event: SpeechStreamEventLike): FinalDecision | null;
  /**
   * An UNtagged agent kind:9: true = suppress it, as the CLI copy of what
   * this agent just streamed (§3.6 "streams AND CLI-sends").
   */
  onUntagged(event: SpeechStreamEventLike): boolean;
  /**
   * Barge-in: drop the rest of every open stream (one agent's, or all when
   * no pubkey is given), including the final's tail. Returns the cut keys.
   */
  cut(agentPubkey?: string): string[];
  /** Gap skips and idle closes that are due. */
  poll(): StreamUpdate[];
  /** True while any stream is open (the hook polls only then). */
  hasOpenStreams(): boolean;
}

interface StreamState {
  key: string;
  agent: string;
  nextSeq: number;
  /** End of the delivered text, in UTF-16 units of the final text. */
  spokenUpTo: number;
  pending: Map<number, { offset: number; text: string; done: number | null }>;
  gapSince: number | null;
  /** Seq of the event carrying the done tag, once seen. */
  doneSeq: number | null;
  ended: boolean;
  cut: boolean;
  lastActivity: number;
  /** Everything delivered (for the CLI-duplicate check). */
  heard: string;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .map((w) => w.replace(/^'+|'+$/g, ""))
      .filter((w) => w.length > 0),
  );
}

/** Share of `candidate`'s distinct words that also occur in `reference`. */
export function wordOverlap(candidate: string, reference: string): number {
  const mine = words(candidate);
  if (mine.size === 0) return 0;
  const theirs = words(reference);
  let shared = 0;
  for (const w of mine) if (theirs.has(w)) shared += 1;
  return shared / mine.size;
}

function speakable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith("[System]");
}

export function createSpeechStreamTracker(
  options: {
    now?: () => number;
    log?: (line: string) => void;
    gapHoldMs?: number;
    idleCloseMs?: number;
  } = {},
): SpeechStreamTracker {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.info(line));
  const gapHoldMs = options.gapHoldMs ?? SPEECH_GAP_HOLD_MS;
  const idleCloseMs = options.idleCloseMs ?? SPEECH_IDLE_CLOSE_MS;
  const streams = new Map<string, StreamState>();

  /** Deliver every contiguous pending segment; returns the texts to speak. */
  const drain = (s: StreamState): string[] => {
    const out: string[] = [];
    for (;;) {
      const seg = s.pending.get(s.nextSeq);
      if (!seg) break;
      s.pending.delete(s.nextSeq);
      s.nextSeq += 1;
      // A segment that overlaps what was already delivered contributes only
      // its new part.
      const skip = Math.max(0, s.spokenUpTo - seg.offset);
      const fresh = seg.text.slice(skip);
      s.spokenUpTo = Math.max(s.spokenUpTo, seg.offset + seg.text.length);
      if (fresh.length > 0) {
        s.heard += fresh;
        if (speakable(fresh)) out.push(fresh.trim());
      }
    }
    s.gapSince = s.pending.size > 0 ? (s.gapSince ?? now()) : null;
    if (s.doneSeq !== null && s.nextSeq > s.doneSeq) s.ended = true;
    return out;
  };

  const update = (
    s: StreamState,
    isNew: boolean,
    speak: string[],
    triggerId: string | null,
  ): StreamUpdate => ({
    key: s.key,
    agentPubkey: s.agent,
    isNew,
    speak,
    ended: s.ended,
    triggerId,
  });

  const gc = () => {
    const t = now();
    for (const [key, s] of streams) {
      if (s.ended && t - s.lastActivity > ENDED_RETENTION_MS) {
        streams.delete(key);
      }
    }
  };

  return {
    onSegment(event) {
      const seg = parseSpeechSegment(event);
      if (seg === null) return null;
      const agent = event.pubkey.toLowerCase();
      const key = `${agent}:${seg.streamId}`;
      let s = streams.get(key);
      const isNew = s === undefined;
      if (s === undefined) {
        s = {
          key,
          agent,
          nextSeq: 0,
          spokenUpTo: 0,
          pending: new Map(),
          gapSince: null,
          doneSeq: null,
          ended: false,
          cut: false,
          lastActivity: now(),
          heard: "",
        };
        streams.set(key, s);
      }
      if (s.ended || s.cut) return null;
      s.lastActivity = now();
      // Duplicate (already delivered, or already held).
      if (seg.seq < s.nextSeq || s.pending.has(seg.seq)) {
        return update(s, isNew, [], seg.triggerId);
      }
      if (seg.done !== null) s.doneSeq = seg.seq;
      s.pending.set(seg.seq, {
        offset: seg.offset,
        text: event.content,
        done: seg.done,
      });
      const speak = drain(s);
      return update(s, isNew, speak, seg.triggerId);
    },

    onFinal(event) {
      const streamId = speechStreamIdOfFinal(event);
      if (streamId === null) return null;
      const agent = event.pubkey.toLowerCase();
      const key = `${agent}:${streamId}`;
      const s = streams.get(key);
      if (s === undefined) {
        // Never saw the stream (switch off, old harness, missed segments):
        // speak the whole message, and refuse any late segment of it.
        streams.set(key, {
          key,
          agent,
          nextSeq: 0,
          spokenUpTo: event.content.length,
          pending: new Map(),
          gapSince: null,
          doneSeq: null,
          ended: true,
          cut: false,
          lastActivity: now(),
          heard: event.content,
        });
        return { key, text: event.content, streamOpen: false };
      }
      s.lastActivity = now();
      if (s.cut) return { key, text: null, streamOpen: false };
      const wasOpen = !s.ended;
      // The tail from the end of what was delivered also fills any gap.
      const tail = event.content.slice(s.spokenUpTo);
      s.pending.clear();
      s.gapSince = null;
      s.ended = true;
      s.spokenUpTo = Math.max(s.spokenUpTo, event.content.length);
      s.heard += tail;
      return {
        key,
        text: speakable(tail) ? tail.trim() : null,
        streamOpen: wasOpen,
      };
    },

    onUntagged(event) {
      const agent = event.pubkey.toLowerCase();
      const t = now();
      let reference = "";
      for (const s of streams.values()) {
        if (s.agent !== agent) continue;
        if (t - s.lastActivity > SPEECH_DUPLICATE_WINDOW_MS) continue;
        reference += ` ${s.heard}`;
      }
      if (reference.trim().length === 0) return false;
      const overlap = wordOverlap(event.content, reference);
      if (overlap >= SPEECH_DUPLICATE_OVERLAP) {
        log(
          `[speech-stream] suppressed untagged duplicate from ${agent.slice(0, 8)} overlap=${overlap.toFixed(2)}`,
        );
        return true;
      }
      return false;
    },

    cut(agentPubkey) {
      const who = agentPubkey?.toLowerCase();
      const cutKeys: string[] = [];
      for (const s of streams.values()) {
        if (who !== undefined && s.agent !== who) continue;
        if (s.ended || s.cut) continue;
        s.cut = true;
        s.ended = true;
        s.pending.clear();
        s.gapSince = null;
        cutKeys.push(s.key);
      }
      return cutKeys;
    },

    poll() {
      const t = now();
      const out: StreamUpdate[] = [];
      for (const s of streams.values()) {
        if (s.ended) continue;
        if (s.gapSince !== null && t - s.gapSince >= gapHoldMs) {
          const next = Math.min(...s.pending.keys());
          log(
            `[speech-stream] gap skipped stream=${s.key.slice(0, 8)}… seq ${s.nextSeq}..${next - 1}`,
          );
          s.nextSeq = next;
          s.gapSince = null;
          out.push(update(s, false, drain(s), null));
          continue;
        }
        if (t - s.lastActivity >= idleCloseMs) {
          s.ended = true;
          s.pending.clear();
          s.gapSince = null;
          out.push(update(s, false, [], null));
        }
      }
      gc();
      return out;
    },

    hasOpenStreams() {
      for (const s of streams.values()) if (!s.ended) return true;
      return false;
    },
  };
}

/** A pull queue of text for {@link AgentSpeechPlayer.speakStream}. */
export interface SpeechQueue {
  push(text: string): void;
  /** No more text: `next()` resolves null once the queue drains. */
  close(): void;
  next(): Promise<string | null>;
  /** True when `next()` would resolve without waiting. */
  ready(): boolean;
  readonly closed: boolean;
}

export function createSpeechQueue(): SpeechQueue {
  const items: string[] = [];
  let closed = false;
  let waiter: ((value: string | null) => void) | null = null;
  return {
    push(text) {
      if (closed) return;
      if (waiter) {
        const wake = waiter;
        waiter = null;
        wake(text);
        return;
      }
      items.push(text);
    },
    close() {
      closed = true;
      if (waiter && items.length === 0) {
        const wake = waiter;
        waiter = null;
        wake(null);
      }
    },
    next() {
      if (items.length > 0) return Promise.resolve(items.shift() as string);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    ready() {
      return items.length > 0 || closed;
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Voice-to-first-TTS latency recorder (plan
 * VOICE_STREAMED_REPLIES_2026-10-04 §3.5.6 and §4).
 *
 * One record per agent reply in a call, all on ONE clock
 * (`performance.now()` by default):
 *  - `t0`: a `[voice]` message observed on the huddle's speech
 *    subscription, from anyone in the call;
 *  - `tSeg0`: the first kind-24820 speech segment of the reply (stream
 *    path only);
 *  - `tTts0`: the first `/tts` request issued for the reply;
 *  - `tAudio0`: the first audio scheduled for the reply;
 *  - `path`: `stream` (spoken from segments) or `final` (spoken from an
 *    ordinary kind:9).
 *
 * The acceptance metric is `tTts0 - t0`. Records live in a ring buffer
 * (last 50) published on `window.__buzzVoiceLatency`, and every milestone
 * also logs one `console.info("[voice-latency] …")` line, so a live call can
 * be measured from the console of Sam's PWA (or Agent Brave in the same
 * huddle) with no build flag.
 *
 * PAIRING. A reply pairs with the `[voice]` turn named by its `e` tag when
 * that turn is open in the same channel; otherwise with the LATEST unclaimed
 * turn in the same channel (the harness answers the last event of a batch,
 * so earlier unclaimed turns in that channel are superseded and closed). A
 * reply with no open turn in its channel is not recorded — an agent talking
 * unprompted is not a latency sample.
 */

export type VoiceReplyPath = "stream" | "final";

export interface VoiceLatencyRecord {
  channelId: string;
  /** The `[voice]` event that started the turn. */
  triggerId: string;
  /** Lowercase pubkey of the agent whose reply paired, once one did. */
  agentPubkey: string | null;
  t0: number;
  tSeg0: number | null;
  tTts0: number | null;
  tAudio0: number | null;
  path: VoiceReplyPath | null;
}

/** Opaque handle the speech path carries from "reply seen" to "audio". */
export interface VoiceLatencyReply {
  /** Mark the first `/tts` request (later calls are ignored). */
  ttsRequested(): void;
  /** Mark the first audio scheduled (later calls are ignored). */
  audioStarted(): void;
}

export interface VoiceLatencyRecorder {
  /** A `[voice]` message was observed in `channelId`. */
  voiceTurn(channelId: string, eventId: string): void;
  /**
   * An agent reply began arriving. `triggerId` is the reply's `e` tag, when
   * it carries one. Returns null when there is no open turn to pair with.
   */
  reply(
    channelId: string,
    agentPubkey: string,
    path: VoiceReplyPath,
    triggerId?: string | null,
  ): VoiceLatencyReply | null;
  /** The ring, oldest first (the same array `window.__buzzVoiceLatency` holds). */
  records(): readonly VoiceLatencyRecord[];
}

export const VOICE_LATENCY_RING_SIZE = 50;

/** No-op handle, so call sites never branch on "was this recorded". */
export const NO_LATENCY_REPLY: VoiceLatencyReply = {
  ttsRequested() {},
  audioStarted() {},
};

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function ms(from: number, to: number | null): string {
  return to === null ? "-" : `+${Math.round(to - from)}ms`;
}

export function createVoiceLatencyRecorder(
  options: {
    now?: () => number;
    log?: (line: string) => void;
    ringSize?: number;
    /** Where the ring is published; null = nowhere (tests). */
    publish?: ((ring: VoiceLatencyRecord[]) => void) | null;
  } = {},
): VoiceLatencyRecorder {
  const now = options.now ?? defaultNow;
  const log = options.log ?? ((line: string) => console.info(line));
  const ringSize = options.ringSize ?? VOICE_LATENCY_RING_SIZE;
  const ring: VoiceLatencyRecord[] = [];
  options.publish?.(ring);
  /** Unclaimed turns, oldest first. */
  const open: VoiceLatencyRecord[] = [];

  const summary = (r: VoiceLatencyRecord) =>
    `channel=${r.channelId.slice(0, 8)} trigger=${r.triggerId.slice(0, 8)} ` +
    `path=${r.path ?? "-"} seg0=${ms(r.t0, r.tSeg0)} tts0=${ms(r.t0, r.tTts0)} ` +
    `audio0=${ms(r.t0, r.tAudio0)}`;

  return {
    voiceTurn(channelId, eventId) {
      if (ring.some((r) => r.triggerId === eventId)) return;
      const record: VoiceLatencyRecord = {
        channelId,
        triggerId: eventId,
        agentPubkey: null,
        t0: now(),
        tSeg0: null,
        tTts0: null,
        tAudio0: null,
        path: null,
      };
      ring.push(record);
      while (ring.length > ringSize) ring.shift();
      open.push(record);
      log(`[voice-latency] t0 ${summary(record)}`);
    },
    reply(channelId, agentPubkey, path, triggerId) {
      const inChannel = open.filter((r) => r.channelId === channelId);
      if (inChannel.length === 0) return null;
      const byTag =
        triggerId != null
          ? inChannel.find((r) => r.triggerId === triggerId)
          : undefined;
      const record = byTag ?? inChannel[inChannel.length - 1];
      // Claim it, and close every OLDER unclaimed turn in this channel.
      for (let i = open.length - 1; i >= 0; i--) {
        const r = open[i];
        if (r === record || (r.channelId === channelId && r.t0 <= record.t0)) {
          open.splice(i, 1);
        }
      }
      record.agentPubkey = agentPubkey.toLowerCase();
      record.path = path;
      if (path === "stream") record.tSeg0 = now();
      log(`[voice-latency] reply ${summary(record)}`);
      return {
        ttsRequested() {
          if (record.tTts0 !== null) return;
          record.tTts0 = now();
          log(`[voice-latency] tts0 ${summary(record)}`);
        },
        audioStarted() {
          if (record.tAudio0 !== null) return;
          record.tAudio0 = now();
          log(`[voice-latency] audio0 ${summary(record)}`);
        },
      };
    },
    records() {
      return ring;
    },
  };
}

declare global {
  interface Window {
    __buzzVoiceLatency?: VoiceLatencyRecord[];
  }
}

let shared: VoiceLatencyRecorder | null = null;

/** The page-wide recorder, publishing its ring on `window.__buzzVoiceLatency`. */
export function voiceLatency(): VoiceLatencyRecorder {
  shared ??= createVoiceLatencyRecorder({
    publish: (ring) => {
      if (typeof window !== "undefined") window.__buzzVoiceLatency = ring;
    },
  });
  return shared;
}

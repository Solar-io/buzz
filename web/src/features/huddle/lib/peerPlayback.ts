/**
 * Per-peer Opus decode and jitter-buffered playback for a huddle downlink.
 *
 * One decoder per occupied `peer_index`, keyed by index and guarded by the
 * relay's occupancy EPOCH: the relay bumps a slot's epoch when an index is
 * reused (`index_epochs`, crates/buzz-relay/src/audio/room.rs), and an Opus
 * decoder must never carry state across two different speakers — so a frame
 * whose epoch differs closes the old decoder and starts a fresh one.
 *
 * Every decoded buffer is scheduled at least {@link PLAYBACK_LEAD_S} ahead
 * of now and never before the previous buffer's end, which is the whole
 * jitter buffer: frames arriving late land after the ones already queued
 * rather than on top of them.
 *
 * Extracted from `useHuddleAudio.ts` so that hook stays a lifecycle. The
 * context and the destination node are supplied as GETTERS rather than
 * values, because both are replaced over a call's life — the destination in
 * particular is the speaker-mute gain, created at join.
 */

import { PLAYBACK_LEAD_S, US_PER_SAMPLE } from "./huddleAudioGraph.ts";

interface PeerDecoder {
  decoder: AudioDecoder;
  nextStart: number;
  epoch: number;
}

export interface PeerPlayback {
  /** Decode and schedule one downlink frame. Silent no-op for DTX/empty. */
  play: (
    peerIndex: number,
    epoch: number,
    opus: Uint8Array,
    ts48k: number,
    dtx: boolean,
  ) => void;
  /** Close every decoder and forget the roster (socket teardown). */
  closeAll: () => void;
}

export function createPeerPlayback(options: {
  getContext: () => AudioContext | null;
  /** Where decoded audio is connected; falls back to the context's output. */
  getDestination: () => AudioNode | null;
}): PeerPlayback {
  const decoders = new Map<number, PeerDecoder>();

  return {
    play(peerIndex, epoch, opus, ts48k, dtx) {
      const ctx = options.getContext();
      if (ctx === null || dtx || opus.length === 0) {
        return;
      }
      let entry = decoders.get(peerIndex);
      if (!entry || entry.decoder.state === "closed" || entry.epoch !== epoch) {
        if (entry && entry.decoder.state !== "closed") {
          entry.decoder.close();
        }
        const decoder = new AudioDecoder({
          output: (audioData: AudioData) => {
            const sink = decoders.get(peerIndex);
            if (!sink) {
              audioData.close();
              return;
            }
            const samples = new Float32Array(audioData.numberOfFrames);
            audioData.copyTo(samples, { planeIndex: 0, format: "f32" });
            audioData.close();
            const buffer = ctx.createBuffer(1, samples.length, 48_000);
            buffer.copyToChannel(samples, 0);
            const sourceNode = ctx.createBufferSource();
            sourceNode.buffer = buffer;
            // Through the caller's destination — the speaker-mute gain —
            // never straight at ctx.destination: the mute has to silence
            // audio that is ALREADY scheduled in the jitter buffer, which
            // a per-source check cannot do.
            sourceNode.connect(options.getDestination() ?? ctx.destination);
            const startAt = Math.max(
              sink.nextStart,
              ctx.currentTime + PLAYBACK_LEAD_S,
            );
            sourceNode.start(startAt);
            sink.nextStart = startAt + samples.length / 48_000;
          },
          error: () => {
            decoders.delete(peerIndex);
          },
        });
        decoder.configure({
          codec: "opus",
          sampleRate: 48_000,
          numberOfChannels: 1,
        });
        entry = { decoder, nextStart: 0, epoch };
        decoders.set(peerIndex, entry);
      }
      entry.decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round(ts48k * US_PER_SAMPLE),
          data: new Uint8Array(
            opus.buffer instanceof ArrayBuffer
              ? opus.buffer
              : new ArrayBuffer(0),
            opus.byteOffset,
            opus.byteLength,
          ),
        }),
      );
    },
    closeAll() {
      for (const { decoder } of decoders.values()) {
        if (decoder.state !== "closed") {
          decoder.close();
        }
      }
      decoders.clear();
    },
  };
}

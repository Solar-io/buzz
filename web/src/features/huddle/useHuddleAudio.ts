import { useCallback, useEffect, useRef, useState } from "react";
import { authEventTemplate } from "@/shared/api/relay-session";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { getAuthTagJson } from "@/shared/lib/key-store";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import {
  buildUplinkFrame,
  parseDownlinkFrame,
  rmsToDbov,
} from "./lib/huddleWire.ts";

/**
 * Huddle voice for the web: one WebSocket to /huddle/{id}/audio, mic capture
 * → WebCodecs Opus → 8-byte-header binary frames up; prefixed frames down →
 * per-peer Opus decode → jitter-buffered playback. Roster comes from the
 * room's control messages; speaking levels from frame telemetry.
 *
 * Browsers without WebCodecs audio (older Safari) expose supportsVoice=false;
 * join() is then refused with a clear message rather than a broken call.
 */

export interface HuddlePeer {
  pubkey: string;
  peerIndex: number;
  epoch: number;
}

export type HuddleStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Open mic or push-to-talk — the desktop's `VoiceInputMode`.
 *
 * The desktop binds PTT to a global hotkey through Tauri, which a web page
 * cannot do: a browser has no access to keystrokes outside its own document,
 * so a background PTT key is not implementable here at any effort. What IS
 * implementable is a hold-to-talk control inside the page, and Space while
 * the huddle bar itself has focus. Both are wired; the global hotkey is not,
 * and cannot be.
 */
export type VoiceInputMode = "open" | "push_to_talk";

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

/** µs per 48 kHz sample (WebCodecs timestamps are µs). */
const US_PER_SAMPLE = 1_000_000 / 48_000;
/** Playback lead-in: schedule audio this far ahead of now (jitter buffer). */
const PLAYBACK_LEAD_S = 0.12;
/** Speaking-indicator refresh cadence. */
const SPEAKING_TICK_MS = 250;

const WORKLET_SOURCE = `
  class UplinkTap extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0][0];
      if (input) this.port.postMessage(input.slice(0));
      return true;
    }
  }
  registerProcessor('uplink-tap', UplinkTap);
`;

interface PeerPlayback {
  decoder: AudioDecoder;
  nextStart: number;
}

export function useHuddleAudio(
  channelId: string | null,
  parentChannelId?: string | null,
) {
  const [status, setStatus] = useState<HuddleStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<HuddlePeer[]>([]);
  const [speaking, setSpeaking] = useState<Map<string, number>>(new Map());
  const [muted, setMuted] = useState(false);
  /** The viewer's own mic level in dBov, for the meter. */
  const [micLevel, setMicLevel] = useState(-127);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>("open");
  const [pttActive, setPttActive] = useState(false);
  const voiceInputModeRef = useRef<VoiceInputMode>("open");
  const pttActiveRef = useRef(false);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [supportsVoice] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.AudioEncoder !== "undefined" &&
      typeof window.AudioDecoder !== "undefined",
  );

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const encoderRef = useRef<AudioEncoder | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vuBinsRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const playbackRef = useRef(new Map<number, PeerPlayback>());
  const mutedRef = useRef(false);
  const seqRef = useRef(0);
  const samplesSentRef = useRef(0);
  const levelRef = useRef(-127);
  const rosterRef = useRef(new Map<number, string>());
  const recentLevelsRef = useRef(new Map<string, number>());
  const speakingTickRef = useRef(0);
  const micLevelTickRef = useRef(0);

  /**
   * Is the mic live right now?
   *
   * Muted always wins. In push-to-talk the key/button must be held; in open
   * mic it is always true. Read through refs because the encoder and worklet
   * callbacks are created once and would otherwise close over stale state.
   */
  const transmitting = useCallback(
    () =>
      !mutedRef.current &&
      (voiceInputModeRef.current === "open" || pttActiveRef.current),
    [],
  );

  const teardown = useCallback(() => {
    for (const { decoder } of playbackRef.current.values()) {
      decoder.close();
    }
    playbackRef.current.clear();
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;
    encoderRef.current?.close();
    encoderRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    vuBinsRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    seqRef.current = 0;
    samplesSentRef.current = 0;
    recentLevelsRef.current.clear();
    setPeers([]);
    setSpeaking(new Map());
    rosterRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  /**
   * Input devices. Labels are empty until the page holds a microphone grant
   * (a privacy rule, not a bug), so this is refreshed again after join —
   * before that, the list exists but reads as "Microphone 1", "Microphone 2".
   */
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all
          .filter((device) => device.kind === "audioinput")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${index + 1}`,
          })),
      );
    } catch {
      // Enumeration is a convenience; the default device still works.
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) {
      return;
    }
    const onChange = () => void refreshDevices();
    media.addEventListener("devicechange", onChange);
    return () => media.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  /** Decode + jitter-schedule one downlink frame's Opus payload. */
  const playFrame = useCallback(
    (peerIndex: number, opus: Uint8Array, ts48k: number, dtx: boolean) => {
      const ctx = ctxRef.current;
      if (!ctx || dtx || opus.length === 0) {
        return;
      }
      let entry = playbackRef.current.get(peerIndex);
      if (!entry || entry.decoder.state === "closed") {
        const decoder = new AudioDecoder({
          output: (audioData: AudioData) => {
            const sink = playbackRef.current.get(peerIndex);
            if (!sink) {
              audioData.close();
              return;
            }
            const samples = new Float32Array(audioData.numberOfFrames);
            audioData.copyTo(samples, {
              planeIndex: 0,
              format: "f32",
            });
            audioData.close();
            const buffer = ctx.createBuffer(1, samples.length, 48_000);
            buffer.copyToChannel(samples, 0);
            const sourceNode = ctx.createBufferSource();
            sourceNode.buffer = buffer;
            sourceNode.connect(ctx.destination);
            const startAt = Math.max(
              sink.nextStart,
              ctx.currentTime + PLAYBACK_LEAD_S,
            );
            sourceNode.start(startAt);
            sink.nextStart = startAt + samples.length / 48_000;
          },
          error: () => {
            playbackRef.current.delete(peerIndex);
          },
        });
        decoder.configure({
          codec: "opus",
          sampleRate: 48_000,
          numberOfChannels: 1,
        });
        entry = { decoder, nextStart: 0 };
        playbackRef.current.set(peerIndex, entry);
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
    [],
  );

  const applyRoster = useCallback(
    (
      raw: {
        pubkey: string;
        peer_index?: number;
        peerIndex?: number;
        epoch?: number;
      }[],
    ) => {
      const roster = raw.map((peer) => ({
        pubkey: peer.pubkey,
        peerIndex: peer.peer_index ?? peer.peerIndex ?? 0,
        epoch: peer.epoch ?? 0,
      }));
      rosterRef.current = new Map(
        roster.map((peer) => [peer.peerIndex, peer.pubkey]),
      );
      setPeers(roster);
    },
    [],
  );

  const leave = useCallback(() => {
    teardown();
    setStatus("idle");
    setMuted(false);
    mutedRef.current = false;
  }, [teardown]);

  const join = useCallback(async () => {
    if (!channelId || !supportsVoice) {
      setError(
        supportsVoice
          ? "No huddle selected."
          : "This browser can't encode voice (no WebCodecs audio) — join from the desktop app.",
      );
      return;
    }
    setError(null);
    setStatus("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // A chosen device is a REQUIREMENT, not a hint: `exact` makes the
          // browser fail loudly if the mic was unplugged, instead of quietly
          // opening a different one and leaving the picker lying about it.
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      streamRef.current = stream;
      trackRef.current = stream.getAudioTracks()[0] ?? null;
      // Device labels are blank until a getUserMedia grant exists, so this is
      // the first moment enumeration is worth anything.
      void refreshDevices();
      const ctx = new AudioContext({ sampleRate: 48_000 });
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;
      vuBinsRef.current = new Float32Array(
        new ArrayBuffer(analyser.fftSize * 4),
      );

      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
      );
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      const worklet = new AudioWorkletNode(ctx, "uplink-tap");
      source.connect(worklet);
      workletRef.current = worklet;

      const encoder = new AudioEncoder({
        output: (chunk) => {
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN || !transmitting()) {
            return;
          }
          const opus = new Uint8Array(new ArrayBuffer(chunk.byteLength));
          chunk.copyTo(opus);
          ws.send(
            buildUplinkFrame(
              seqRef.current++,
              Math.round(chunk.timestamp / US_PER_SAMPLE),
              levelRef.current,
              opus,
            ),
          );
        },
        error: (encodeError) =>
          setError(encodeError.message || "Mic encoding failed."),
      });
      encoder.configure({
        codec: "opus",
        sampleRate: 48_000,
        numberOfChannels: 1,
        bitrate: 32_000,
      });
      encoderRef.current = encoder;

      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const current = encoderRef.current;
        if (!current) {
          return;
        }
        // Level is measured from the raw capture, BEFORE the mute/PTT gate.
        // A meter that goes flat when you are muted cannot answer the only
        // question anyone asks it: "is my mic picking me up?"
        let sumSquares = 0;
        for (const sample of event.data) {
          sumSquares += sample * sample;
        }
        levelRef.current = rmsToDbov(
          Math.sqrt(sumSquares / Math.max(1, event.data.length)),
        );
        const now = Date.now();
        if (now - micLevelTickRef.current > SPEAKING_TICK_MS) {
          micLevelTickRef.current = now;
          setMicLevel(levelRef.current);
        }
        if (!transmitting()) {
          return;
        }
        const frames = event.data.length;
        const timestamp = Math.round(samplesSentRef.current * US_PER_SAMPLE);
        samplesSentRef.current += frames;
        // Copy into a known-ArrayBuffer view — the message port hands us a
        // transferable whose type is too wide for BufferSource.
        const pcm = new Float32Array(new ArrayBuffer(frames * 4));
        pcm.set(event.data);
        current.encode(
          new AudioData({
            format: "f32",
            sampleRate: 48_000,
            numberOfFrames: frames,
            numberOfChannels: 1,
            timestamp,
            data: pcm,
          }),
        );
      };

      const base = new URL(relayWsUrl());
      const socketUrl = `${base.protocol === "wss:" ? "wss" : "ws"}://${base.host}/huddle/${channelId}/audio`;
      const ws = new WebSocket(socketUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          let message: {
            type: string;
            challenge?: string;
            message?: string;
            peers?: {
              pubkey: string;
              peer_index?: number;
              peerIndex?: number;
              epoch?: number;
            }[];
          };
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "challenge" && message.challenge) {
            void signNostrEvent(
              authEventTemplate(
                message.challenge,
                relayWsUrl(),
                getAuthTagJson(),
              ),
            )
              .then((authEvent) => {
                ws.send(
                  JSON.stringify({
                    type: "auth",
                    event: authEvent,
                    protocol_version: 3,
                    ...(parentChannelId
                      ? { parent_channel_id: parentChannelId }
                      : {}),
                  }),
                );
              })
              .catch(() => {
                setError("Could not sign the huddle auth challenge.");
                teardown();
                setStatus("error");
              });
            return;
          }
          if (message.type === "joined") {
            setStatus("connected");
            applyRoster(message.peers ?? []);
            return;
          }
          if (message.type === "left") {
            applyRoster(message.peers ?? []);
            return;
          }
          if (message.type === "error") {
            setError(message.message ?? "The huddle rejected the connection.");
            teardown();
            setStatus("error");
          }
          return;
        }
        const frame = parseDownlinkFrame(event.data as ArrayBuffer);
        if (!frame) {
          return;
        }
        playFrame(frame.peerIndex, frame.opus, frame.ts48k, frame.dtx);
        const pubkey = rosterRef.current.get(frame.peerIndex);
        if (pubkey) {
          recentLevelsRef.current.set(pubkey, frame.levelDbov);
        }
        const now = Date.now();
        if (now - speakingTickRef.current > SPEAKING_TICK_MS) {
          speakingTickRef.current = now;
          setSpeaking(new Map(recentLevelsRef.current));
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) {
          teardown();
          setStatus("idle");
        }
      };
      ws.onerror = () => {
        setError("Could not reach the huddle audio service.");
      };
    } catch (mediaError) {
      teardown();
      setStatus("error");
      setError(
        mediaError instanceof Error && mediaError.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : mediaError instanceof Error
            ? mediaError.message
            : "Could not start the microphone.",
      );
    }
  }, [
    channelId,
    parentChannelId,
    supportsVoice,
    teardown,
    playFrame,
    applyRoster,
    deviceId,
    transmitting,
    refreshDevices,
  ]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      mutedRef.current = next;
      // Disable the TRACK too, not just the uplink. Dropping encoded frames
      // stops the relay hearing you, but the browser keeps the capture
      // indicator lit — so the OS says "this page is listening" while the UI
      // says "muted". `track.enabled = false` is what actually stops it.
      if (trackRef.current) {
        trackRef.current.enabled = !next;
      }
      return next;
    });
  }, []);

  const selectDevice = useCallback((nextDeviceId: string) => {
    setDeviceId(nextDeviceId);
  }, []);

  const setMode = useCallback((mode: VoiceInputMode) => {
    voiceInputModeRef.current = mode;
    setVoiceInputMode(mode);
    if (mode === "push_to_talk") {
      pttActiveRef.current = false;
      setPttActive(false);
    }
  }, []);

  const setPushToTalkActive = useCallback((active: boolean) => {
    pttActiveRef.current = active;
    setPttActive(active);
  }, []);

  return {
    status,
    error,
    peers,
    speaking,
    muted,
    micLevel,
    devices,
    deviceId,
    voiceInputMode,
    pttActive,
    supportsVoice,
    join,
    leave,
    toggleMute,
    selectDevice,
    setVoiceInputMode: setMode,
    setPushToTalkActive,
  };
}

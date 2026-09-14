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

export type HuddleStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

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
/**
 * Redial delays after an unexpected audio-socket drop, in ms. The DESKTOP's
 * ladder exactly (desktop/src/features/huddle/HuddleContext.tsx — the list
 * `[0, 100, 250, 500, 1_000, 2_000, 2_000]`, sized for endpoint-drain
 * handoff): early retries catch a blip fast, the 2s tail covers a relay
 * restart. Only the SOCKET is redialed — mic, context, and encoder stay
 * live, so a successful reconnect is a short audio gap, not a rejoin. When
 * the ladder runs out the call ends with the reason on screen.
 */
const RECONNECT_DELAYS_MS = [0, 100, 250, 500, 1_000, 2_000, 2_000];

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
  /**
   * The occupancy epoch this decoder was created for. The relay bumps a
   * slot's epoch when a peer_index is reused
   * (crates/buzz-relay/src/audio/room.rs `index_epochs`); a frame whose
   * epoch differs from the entry's belongs to a DIFFERENT occupant of that
   * index, and an Opus decoder must never carry state across speakers.
   */
  epoch: number;
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
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
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
   * Does the USER consider themselves in the call? True from join() until
   * leave()/teardown — across socket drops and the reconnect ladder. It is
   * what separates "the network hiccuped, redial" from "the call is over":
   * ws.onclose checks it to decide between reconnecting and going idle.
   */
  const wantConnectedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  /** deviceId mirror the recovery path reads without re-creating join(). */
  const deviceIdRef = useRef("");
  /**
   * Mic tap subscribers (voice mode's STT bridge). Refs, not state: the
   * worklet port handler is installed once per join and fans out to
   * whoever is subscribed at frame time.
   */
  const micSubscribersRef = useRef(
    new Set<(frame: Float32Array, sampleRate: number) => void>(),
  );

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

  /**
   * Subscribe to the mic tap: every captured frame plus the capture rate.
   * Fan-out from the uplink worklet's port — no second getUserMedia, no
   * second AudioContext. Returns an unsubscribe function.
   */
  const subscribeMicFrames = useCallback(
    (listener: (frame: Float32Array, sampleRate: number) => void) => {
      micSubscribersRef.current.add(listener);
      return () => {
        micSubscribersRef.current.delete(listener);
      };
    },
    [],
  );

  const stopReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Tear down the audio SOCKET and everything derived from it (per-peer
   * decoders, roster, level telemetry) while keeping the mic, context,
   * encoder, and worklet alive. This is the socket-redial half of the
   * desktop's `reconnect_huddle_audio` contract: a recovered connection is
   * an audio blip, not a leave. Handlers are nulled BEFORE close so the
   * in-flight teardown cannot re-enter the reconnect path.
   */
  const teardownSocket = useCallback(() => {
    stopReconnectTimer();
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
      wsRef.current = null;
    }
    for (const { decoder } of playbackRef.current.values()) {
      if (decoder.state !== "closed") {
        decoder.close();
      }
    }
    playbackRef.current.clear();
    rosterRef.current.clear();
    recentLevelsRef.current.clear();
    setPeers([]);
    setSpeaking(new Map());
    seqRef.current = 0;
    samplesSentRef.current = 0;
  }, [stopReconnectTimer]);

  const teardown = useCallback(() => {
    wantConnectedRef.current = false;
    stopReconnectTimer();
    teardownSocket();
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;
    encoderRef.current?.close();
    encoderRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    vuBinsRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    trackRef.current = null;
  }, [stopReconnectTimer, teardownSocket]);

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
    (
      peerIndex: number,
      epoch: number,
      opus: Uint8Array,
      ts48k: number,
      dtx: boolean,
    ) => {
      const ctx = ctxRef.current;
      if (!ctx || dtx || opus.length === 0) {
        return;
      }
      let entry = playbackRef.current.get(peerIndex);
      if (!entry || entry.decoder.state === "closed" || entry.epoch !== epoch) {
        // A reused peer_index with a bumped epoch is a DIFFERENT occupant:
        // close the old decoder so no Opus state carries across speakers.
        if (entry && entry.decoder.state !== "closed") {
          entry.decoder.close();
        }
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
        entry = { decoder, nextStart: 0, epoch };
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

  // Mutual-recursion breakers: the socket's onclose schedules a redial,
  // and the redial opens a socket whose onclose schedules again. Both
  // live behind refs so neither callback captures the other.
  const scheduleReconnectRef = useRef<(attempt: number) => void>(() => {});
  const connectSocketRef = useRef<() => void>(() => {});
  const recoverMicRef = useRef<() => void>(() => {});

  /**
   * One rung of the redial ladder. `attempt` is the number of FAILED dials
   * so far (0 = first retry). Exhausting the ladder ends the call with the
   * reason visible — the old behavior silently flipped the bar back to the
   * join screen, which is precisely the "call died on a hiccup" complaint.
   */
  const scheduleReconnect = useCallback(
    (attempt: number) => {
      if (attempt >= RECONNECT_DELAYS_MS.length) {
        wantConnectedRef.current = false;
        teardown();
        setError(
          "Connection to the huddle was lost — rejoin when you're back online.",
        );
        setStatus("idle");
        return;
      }
      reconnectAttemptRef.current = attempt;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!wantConnectedRef.current) {
          return;
        }
        connectSocketRef.current();
      }, RECONNECT_DELAYS_MS[attempt]);
    },
    [teardown],
  );

  /**
   * Open (or redial) the audio WebSocket: challenge → signed auth → join.
   * Split out of join() so the reconnect ladder can redial JUST this —
   * the mic graph it took a permission grant to build stays alive, which
   * is the desktop's `reconnect_huddle_audio` contract in browser form.
   */
  const connectSocket = useCallback(() => {
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
          reconnectAttemptRef.current = 0;
          setStatus("connected");
          applyRoster(message.peers ?? []);
          return;
        }
        if (message.type === "left") {
          applyRoster(message.peers ?? []);
          return;
        }
        if (message.type === "error") {
          // The relay refused us (room ended, membership, capacity). Not a
          // transient drop — redialing would hit the same wall.
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
      playFrame(
        frame.peerIndex,
        frame.epoch,
        frame.opus,
        frame.ts48k,
        frame.dtx,
      );
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
      if (wsRef.current !== ws) {
        // A newer dial owns the refs; this close is stale.
        return;
      }
      // The socket is dead and its roster with it. Keep the mic, context,
      // encoder, and worklet alive — a recovered redial is an audio blip,
      // not a leave — and either redial or land on idle, never silently.
      for (const { decoder } of playbackRef.current.values()) {
        if (decoder.state !== "closed") {
          decoder.close();
        }
      }
      playbackRef.current.clear();
      rosterRef.current.clear();
      recentLevelsRef.current.clear();
      setPeers([]);
      setSpeaking(new Map());
      seqRef.current = 0;
      samplesSentRef.current = 0;
      wsRef.current = null;
      if (!wantConnectedRef.current) {
        setStatus("idle");
        return;
      }
      setStatus("reconnecting");
      scheduleReconnectRef.current(reconnectAttemptRef.current + 1);
    };
    ws.onerror = () => {
      setError("Could not reach the huddle audio service.");
    };
  }, [channelId, parentChannelId, playFrame, applyRoster, teardown]);

  /**
   * The mic track died mid-call (unplug, OS reclaim). Try the configured
   * device, then the system default; on success swap the fresh capture
   * into the LIVE graph — analyser, worklet, encoder, and socket all stay
   * up, so recovery is a gap in uplink, not a dropped call. On total
   * failure end the call with the reason on screen.
   */
  const recoverMic = useCallback(async () => {
    if (!wantConnectedRef.current) {
      return;
    }
    const constraints = (id: string): MediaTrackConstraints => ({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(id ? { deviceId: { exact: id } } : {}),
    });
    let stream: MediaStream | null = null;
    let fellBackToDefault = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: constraints(deviceIdRef.current),
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: constraints(""),
        });
        fellBackToDefault = deviceIdRef.current !== "";
      } catch {
        wantConnectedRef.current = false;
        teardown();
        setError("The microphone was disconnected and could not be restarted.");
        setStatus("error");
        return;
      }
    }
    const ctx = ctxRef.current;
    const analyser = analyserRef.current;
    const worklet = workletRef.current;
    if (!ctx || !analyser || !worklet) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }
    const oldStream = streamRef.current;
    streamRef.current = stream;
    const track = stream.getAudioTracks()[0] ?? null;
    trackRef.current = track;
    if (track) {
      track.onended = () => recoverMicRef.current();
    }
    if (fellBackToDefault) {
      deviceIdRef.current = "";
      setDeviceId("");
    }
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    source.connect(worklet);
    sourceRef.current?.disconnect();
    sourceRef.current = source;
    for (const old of oldStream?.getTracks() ?? []) {
      old.stop();
    }
    void refreshDevices();
  }, [teardown, refreshDevices]);

  /**
   * Resume a browser-suspended AudioContext. Called from the bar's
   * pointerdown — a gesture — because a context suspended by the system
   * (device change, OS pause) cannot be resumed without one. No-op when
   * running.
   */
  const resumeAudio = useCallback(async () => {
    const ctx = ctxRef.current;
    if (ctx?.state !== "suspended") {
      return;
    }
    try {
      await ctx.resume();
      setError(null);
    } catch {
      // Still gesture-blocked; the banner stays until a click succeeds.
    }
  }, []);

  const leave = useCallback(() => {
    teardown();
    setStatus("idle");
    setMuted(false);
    mutedRef.current = false;
  }, [teardown]);

  scheduleReconnectRef.current = scheduleReconnect;
  connectSocketRef.current = connectSocket;
  recoverMicRef.current = () => void recoverMic();

  const join = useCallback(async () => {
    if (!channelId || !supportsVoice) {
      setError(
        supportsVoice
          ? "No huddle selected."
          : "This browser can't encode voice (no WebCodecs audio) — join from the desktop app.",
      );
      return;
    }
    if (wantConnectedRef.current || wsRef.current || ctxRef.current) {
      // Already in a call or mid-join (the button disables during
      // "connecting", but a fast double event can still land here).
      return;
    }
    setError(null);
    setStatus("connecting");
    deviceIdRef.current = deviceId;
    wantConnectedRef.current = true;
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
      const track = stream.getAudioTracks()[0] ?? null;
      trackRef.current = track;
      // A track that ends mid-call (unplug, OS reclaim) is recoverable:
      // recoverMic swaps a fresh capture into the live graph.
      if (track) {
        track.onended = () => recoverMicRef.current();
      }
      // Device labels are blank until a getUserMedia grant exists, so this is
      // the first moment enumeration is worth anything.
      void refreshDevices();
      const ctx = new AudioContext({ sampleRate: 48_000 });
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      // A context the SYSTEM suspends mid-call (device change, OS pause)
      // kills capture AND playback silently. Try to resume; if the browser
      // insists on a gesture, say so — resumeAudio() runs on the bar's
      // next pointerdown.
      ctx.onstatechange = () => {
        if (ctx.state !== "suspended" || !wantConnectedRef.current) {
          return;
        }
        void ctx
          .resume()
          .then(() => {
            if (ctxRef.current === ctx) {
              setError(null);
            }
          })
          .catch(() => {
            setError(
              "Audio was paused by the browser — click the huddle bar to resume.",
            );
          });
      };
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

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
        // Mic tap subscribers (voice mode's STT bridge) see every frame
        // regardless of the mute/PTT gate — each subscriber applies its
        // own, and the voice hook deliberately drains frames while dark.
        const tapRate = ctxRef.current?.sampleRate ?? 48_000;
        for (const listener of micSubscribersRef.current) {
          listener(event.data, tapRate);
        }
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

      // Socket + auth + roster handling live in connectSocket so the
      // reconnect ladder redials exactly this half.
      connectSocketRef.current();
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
    supportsVoice,
    teardown,
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
    deviceIdRef.current = nextDeviceId;
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

  /**
   * Is the mic live for transmission right now — the same answer
   * `transmitting()` gives the encoder callbacks, as state the bar can
   * pass to voice mode so a dark mic never publishes transcripts.
   */
  const micLive = !muted && (voiceInputMode === "open" || pttActive);

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
    micLive,
    supportsVoice,
    join,
    leave,
    toggleMute,
    selectDevice,
    setVoiceInputMode: setMode,
    setPushToTalkActive,
    subscribeMicFrames,
    resumeAudio,
  };
}

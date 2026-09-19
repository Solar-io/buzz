import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { authEventTemplate } from "@/shared/api/relay-session";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { getAuthTagJson } from "@/shared/lib/key-store";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import {
  buildUplinkFrame,
  parseDownlinkFrame,
  rmsToDbov,
} from "./lib/huddleWire.ts";
import {
  micConstraints,
  RECONNECT_DELAYS_MS,
  SPEAKING_TICK_MS,
  US_PER_SAMPLE,
  WORKLET_SOURCE,
} from "./lib/huddleAudioGraph.ts";
import {
  audioInputOptions,
  loadAudioDevicePrefs,
  patchAudioDevicePrefs,
  resolveDeviceId,
  SYSTEM_DEFAULT_DEVICE_ID,
  type AudioDeviceOption,
} from "./lib/audioDevices.ts";
import { useHuddleOutput } from "./useHuddleOutput.ts";
import { createPeerPlayback } from "./lib/peerPlayback.ts";
import { shouldContinueAudioJoin } from "./lib/huddleCallLifecycle.ts";

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

/** Kept as the hook's public name for one device row. */
export type AudioInputDevice = AudioDeviceOption;

/** The browser store device choices persist to; null outside a browser. */
function devicePrefsStore(): Storage | null {
  return typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : null;
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
  const [deviceId, setDeviceId] = useState(
    () => loadAudioDevicePrefs(devicePrefsStore()).inputDeviceId,
  );
  /**
   * The mic held by the DUPLEX GATE (`lib/duplexGate.ts`), never by the
   * user. Deliberately separate from `muted`: half-duplex must be able to
   * hold and release the mic without touching — or restoring the wrong
   * value into — the user's own mute.
   */
  const [held, setHeldState] = useState(false);
  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>("open");
  const [pttActive, setPttActive] = useState(false);
  const voiceInputModeRef = useRef<VoiceInputMode>("open");
  const pttActiveRef = useRef(false);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const heldRef = useRef(false);
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
  const outputGainRef = useRef<GainNode | null>(null);
  const playbackRef = useRef(
    createPeerPlayback({
      getContext: () => ctxRef.current,
      getDestination: () => outputGainRef.current,
    }),
  );
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
  /** Invalidates delayed getUserMedia/AudioContext work after a leave. */
  const audioGenerationRef = useRef(0);
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

  // Where this browser plays the call — speaker choice and the one mute
  // that covers peers and the agent alike (useHuddleOutput for why it is a
  // gain node and not a per-source flag).
  const output = useHuddleOutput(useCallback(() => ctxRef.current, []));
  const {
    applyEnumeration: applyOutputEnumeration,
    attach: attachOutput,
    detach: detachOutput,
  } = output;
  const joinIsCurrent = useCallback(
    (generation: number) =>
      shouldContinueAudioJoin({
        joinGeneration: generation,
        currentGeneration: audioGenerationRef.current,
        wantsConnection: wantConnectedRef.current,
      }),
    [],
  );

  /**
   * Is the mic live right now?
   *
   * Muted always wins, and the duplex gate's HOLD is a second, independent
   * veto (half-duplex parks the mic while the agent speaks). In push-to-talk
   * the key/button must be held; in open mic it is always true. Read through
   * refs because the encoder and worklet callbacks are created once and
   * would otherwise close over stale state.
   */
  const transmitting = useCallback(
    () =>
      !mutedRef.current &&
      !heldRef.current &&
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
    playbackRef.current.closeAll();
    rosterRef.current.clear();
    recentLevelsRef.current.clear();
    setPeers([]);
    setSpeaking(new Map());
    seqRef.current = 0;
    samplesSentRef.current = 0;
  }, [stopReconnectTimer]);

  const teardown = useCallback(() => {
    audioGenerationRef.current += 1;
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
    detachOutput();
    outputGainRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    trackRef.current = null;
  }, [stopReconnectTimer, teardownSocket, detachOutput]);

  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  /** Remember the chosen mic without disturbing the chosen speaker. */
  const persistInputDevice = useCallback((inputDeviceId: string) => {
    patchAudioDevicePrefs(devicePrefsStore(), { inputDeviceId });
  }, []);

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
      const inputs = audioInputOptions(all);
      setDevices(inputs);
      applyOutputEnumeration(all);
      // A remembered device that has been unplugged must not be handed to
      // getUserMedia as an `exact` constraint (it would fail the join) or
      // to setSinkId (it would reject) — fall back to the system default.
      const resolvedInput = resolveDeviceId(deviceIdRef.current, inputs);
      if (resolvedInput !== deviceIdRef.current) {
        deviceIdRef.current = resolvedInput;
        setDeviceId(resolvedInput);
      }
    } catch {
      // Enumeration is a convenience; the default device still works.
    }
  }, [applyOutputEnumeration]);

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

  /** Decode + jitter-schedule one downlink frame (see lib/peerPlayback.ts). */
  const playFrame = useCallback(
    (
      peerIndex: number,
      epoch: number,
      opus: Uint8Array,
      ts48k: number,
      dtx: boolean,
    ) => playbackRef.current.play(peerIndex, epoch, opus, ts48k, dtx),
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
          // A reconnect that succeeds must clear any transient error the
          // drop itself surfaced (QA F1: "lost connection" outliving the
          // recovery reads as a fault the bar never retracted).
          setError(null);
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
          const reason =
            message.message ?? "The huddle rejected the connection.";
          // Never a silent no-op: an inline span a busy bar can scroll past
          // is how a dead-room join read as "the button does nothing" (the
          // V1b repro). The toast says the call did not start, the span
          // carries the relay's verdict.
          toast.error("Could not join the huddle", { description: reason });
          setError(reason);
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
      playbackRef.current.closeAll();
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
  const swapMicStream = useCallback(
    async (wantedDeviceId: string, options: { fatalOnFailure: boolean }) => {
      if (!wantConnectedRef.current) {
        return false;
      }
      const generation = audioGenerationRef.current;
      let stream: MediaStream | null = null;
      let fellBackToDefault = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(wantedDeviceId),
        });
      } catch (firstError) {
        if (!options.fatalOnFailure) {
          // A DELIBERATE pick that the browser refused: say so and keep the
          // call — and the mic it already has — exactly as they were. Ending
          // a healthy call because someone chose a busy device is worse than
          // the refusal.
          setError(
            firstError instanceof Error && firstError.name === "NotAllowedError"
              ? "Microphone permission was denied."
              : "That microphone could not be opened — still using the previous one.",
          );
          return false;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: micConstraints(SYSTEM_DEFAULT_DEVICE_ID),
          });
          fellBackToDefault = wantedDeviceId !== SYSTEM_DEFAULT_DEVICE_ID;
        } catch {
          wantConnectedRef.current = false;
          teardown();
          setError(
            "The microphone was disconnected and could not be restarted.",
          );
          setStatus("error");
          return false;
        }
      }
      if (!joinIsCurrent(generation)) {
        for (const track of stream?.getTracks() ?? []) {
          track.stop();
        }
        return false;
      }
      const ctx = ctxRef.current;
      const analyser = analyserRef.current;
      const worklet = workletRef.current;
      if (!ctx || !analyser || !worklet) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return false;
      }
      const oldStream = streamRef.current;
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0] ?? null;
      trackRef.current = track;
      if (track) {
        track.onended = () => recoverMicRef.current();
        // A fresh track captures by default; honor the mute AND the duplex
        // hold so the OS mic indicator matches the UI after a swap (QA F2).
        track.enabled = !mutedRef.current && !heldRef.current;
      }
      const landedOn = fellBackToDefault
        ? SYSTEM_DEFAULT_DEVICE_ID
        : wantedDeviceId;
      if (landedOn !== deviceIdRef.current) {
        deviceIdRef.current = landedOn;
        setDeviceId(landedOn);
      }
      persistInputDevice(landedOn);
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      source.connect(worklet);
      sourceRef.current?.disconnect();
      sourceRef.current = source;
      for (const old of oldStream?.getTracks() ?? []) {
        old.stop();
      }
      setError(null);
      void refreshDevices();
      return true;
    },
    [teardown, refreshDevices, persistInputDevice, joinIsCurrent],
  );

  /**
   * The mic track died mid-call (unplug, OS reclaim): try the configured
   * device, then the system default, and end the call only if neither
   * opens.
   */
  const recoverMic = useCallback(
    () => swapMicStream(deviceIdRef.current, { fatalOnFailure: true }),
    [swapMicStream],
  );

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
    // The duplex hold belongs to a call, not to the user: a rejoin must
    // never start with a mic parked by the last call's agent.
    setHeldState(false);
    heldRef.current = false;
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
    const generation = ++audioGenerationRef.current;
    let pendingContext: AudioContext | null = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(deviceId),
      });
      if (!joinIsCurrent(generation)) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0] ?? null;
      trackRef.current = track;
      if (track) {
        // A hold that was in force when the call started must survive the
        // join, or half-duplex leaks one live mic per rejoin.
        track.enabled = !mutedRef.current && !heldRef.current;
      }
      // A track that ends mid-call (unplug, OS reclaim) is recoverable:
      // recoverMic swaps a fresh capture into the live graph.
      if (track) {
        track.onended = () => recoverMicRef.current();
      }
      // Device labels are blank until a getUserMedia grant exists, so this is
      // the first moment enumeration is worth anything.
      void refreshDevices();
      const ctx = new AudioContext({ sampleRate: 48_000 });
      pendingContext = ctx;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      if (!joinIsCurrent(generation)) {
        await ctx.close();
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
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
      // Everything the room says goes through one gain, so the speaker
      // mute can silence already-scheduled audio; the remembered output
      // device is applied here too, before the first frame arrives.
      outputGainRef.current = attachOutput(ctx);
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
      if (!joinIsCurrent(generation)) {
        await ctx.close();
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
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

      if (!joinIsCurrent(generation)) {
        return;
      }

      // Socket + auth + roster handling live in connectSocket so the
      // reconnect ladder redials exactly this half.
      connectSocketRef.current();
    } catch (mediaError) {
      const stale = !joinIsCurrent(generation);
      if (stale) {
        // A newer join owns the refs now. The older continuation must not
        // tear down its socket or rewrite its status.
        void pendingContext?.close();
        return;
      }
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
    attachOutput,
    joinIsCurrent,
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
        trackRef.current.enabled = !next && !heldRef.current;
      }
      return next;
    });
  }, []);

  /**
   * Choose the microphone. Before a call this is just a preference; DURING
   * one it replaces the uplink track in the live graph — analyser, worklet,
   * encoder and socket all stay up, so switching headsets is a gap in
   * uplink rather than a leave and rejoin.
   */
  const selectDevice = useCallback(
    async (nextDeviceId: string) => {
      if (nextDeviceId === deviceIdRef.current) {
        return;
      }
      if (!wantConnectedRef.current) {
        deviceIdRef.current = nextDeviceId;
        setDeviceId(nextDeviceId);
        persistInputDevice(nextDeviceId);
        return;
      }
      // A refused pick keeps the previous mic and says so; swapMicStream
      // owns both the swap and the persistence of where it landed.
      await swapMicStream(nextDeviceId, { fatalOnFailure: false });
    },
    [swapMicStream, persistInputDevice],
  );

  /**
   * The DUPLEX GATE's hold. Disables the track exactly as mute does — the
   * OS indicator has to go dark too, or half-duplex reads as "it is still
   * listening to me" — but through its own flag, so the user's mute is
   * neither read nor written here.
   */
  const setHeld = useCallback((next: boolean) => {
    if (heldRef.current === next) {
      return;
    }
    heldRef.current = next;
    setHeldState(next);
    if (trackRef.current) {
      trackRef.current.enabled = !mutedRef.current && !next;
    }
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
  const micLive = !muted && !held && (voiceInputMode === "open" || pttActive);

  return {
    status,
    error,
    peers,
    speaking,
    muted,
    micLevel,
    devices,
    deviceId,
    outputDevices: output.devices,
    outputDeviceId: output.deviceId,
    speakerMuted: output.muted,
    supportsOutputSelection: output.supported,
    held,
    voiceInputMode,
    pttActive,
    micLive,
    supportsVoice,
    join,
    leave,
    toggleMute,
    toggleSpeakerMuted: output.toggleMuted,
    selectDevice,
    selectOutputDevice: output.selectDevice,
    setHeld,
    setVoiceInputMode: setMode,
    setPushToTalkActive,
    subscribeMicFrames,
    resumeAudio,
  };
}

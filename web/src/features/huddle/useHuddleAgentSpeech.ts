import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  classifySpeakableAgentText,
  createOrderedSpeaker,
  huddleAgentSpeechFilter,
  shouldSpeakLocally,
  SPEECH_REPLAY_WINDOW_SECONDS,
  type SpeakRoute,
} from "./lib/huddleAgentSpeech.ts";
import { botPubkeys } from "./lib/huddleMembers.ts";
import type { HuddleVoiceOverride } from "./lib/huddlePrefs.ts";
import {
  AGENT_SPEECH_SEGMENT_KIND,
  createSpeechQueue,
  createSpeechStreamTracker,
  isAgentSpeechSegment,
  speechStreamIdOfFinal,
  speechTriggerId,
  streamedRepliesEnabled,
  type SpeechQueue,
  type SpeechStreamTracker,
  type StreamUpdate,
} from "./lib/speechStream.ts";
import {
  recordUtterance,
  VOICE_TURN_MARKER,
  type AgentSpeechActivity,
} from "./lib/voiceTranscript.ts";
import { useAgentSpeechPlayer } from "../voice/useAgentSpeechPlayer.ts";
import { voiceLatency } from "../voice/lib/voiceLatency.ts";
import type { HuddleMemberSnapshot } from "./useHuddleMemberSnapshot";

/**
 * Read agent replies aloud in a huddle, in this browser.
 *
 * This is the reachable half of the desktop's TTS and NOT the whole of it —
 * `lib/huddleAgentSpeech.ts` carries the full reachability note with
 * file:line evidence. In one line: selection is identical, synthesis is
 * `speechSynthesis` instead of pocket-tts, and BROADCAST is impossible
 * (the desktop publishes as the agent using a key that only exists in its
 * local store), so what this produces is local playback for the viewer.
 *
 * Off by default. Speech that starts on its own in a call is worse than no
 * speech, and `speechSynthesis.speak` is gated on a user gesture in several
 * browsers anyway — the toggle IS that gesture.
 */

export interface HuddleAgentSpeech {
  /** Does this browser have a speech synthesizer at all? */
  supported: boolean;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Bot members of the huddle, as read from the relay's 39002 snapshot. */
  agentPubkeys: ReadonlySet<string>;
  /** True once a membership snapshot has arrived; speech is mute before. */
  membershipKnown: boolean;
  /**
   * Agents whose voice is already arriving as room audio, so their replies
   * are deliberately NOT spoken here. Surfaced so the UI can say why.
   */
  suppressedAgents: string[];
  /** True while a local utterance is being synthesized right now. */
  speaking: boolean;
  /**
   * Live avatar-speech state for voice mode's echo suppression: a speaking
   * flag plus the ring of recent utterance texts. A stable ref mutated at
   * synthesis boundaries — same-task accurate, no re-render to wait for —
   * because an STT final can land between the moment synthesis starts and
   * the moment React flushes a state update.
   */
  speechActivity: RefObject<AgentSpeechActivity>;
  /**
   * Speak-time disposition per agent pubkey (lowercase), recorded when an
   * utterance is built — the wiring observable that says WHICH path spoke:
   * "selected" (the agent's published kind-30182 voice), "selected-rejected"
   * (published but unusable here — vanished voiceURI or non-English),
   * "derived-bridge" (no selection; the derived Pocket default went through
   * the tts bridge), "derived" (the local-synth draw — reachable only when
   * this browser has no AudioContext, so the bridge request cannot
   * execute), "pocket-bridge" / "eleven-bridge" / "fish-bridge" (the selection names a
   * server-side engine), "pocket-selected-pending-engine" (an imported
   * pocket selection, executed as the derived-bridge default), or
   * "bridge-error-fallback" (the bridge failed mid-reply; local synth
   * rescued it). A ref mutated in place, like {@link speechActivity}:
   * same-task accurate the moment an utterance is built, no re-render to
   * wait for.
   */
  speakRoutes: RefObject<ReadonlyMap<string, SpeakRoute>>;
  /**
   * Stop the current reply NOW and drop whatever is queued behind it —
   * barge-in's whole effect (`lib/duplexGate.ts` decides WHEN).
   *
   * Distinct from `setEnabled(false)`: the reader stays armed, so the NEXT
   * reply is spoken normally. It stops the bridge's already-scheduled
   * buffers as well as the fetch, because a reply is scheduled ahead of the
   * clock and cancelling only the fetch would let her finish the sentence.
   */
  interrupt: () => void;
  /** Route agent audio at a chosen speaker (the dock's speaker menu). */
  setOutputDevice: (deviceId: string) => void;
  /** Silence agent audio at this browser (the dock's speaker button). */
  setMuted: (muted: boolean) => void;
  /**
   * Stage-owned suppression of AGENT speech only (Stage coexistence). True
   * stops the current reply and drops every reply that arrives while set;
   * false lifts it. Never touches the user's speaker mute (`setMuted`) or
   * room audio — a user-muted huddle stays muted after Stage exits.
   */
  setSuppressed: (suppressed: boolean) => void;
}

function speechSynthesisSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined"
  );
}

export function useHuddleAgentSpeech(options: {
  /** The ephemeral huddle channel; null disables the hook. */
  channelId: string | null;
  selfPubkey: string | null;
  /** Pubkeys currently connected to the room's audio, from the roster. */
  audioPeerPubkeys: readonly string[];
  /**
   * Polled roster of the huddle channel — passed in rather than opened here,
   * so this hook and the agent roster share ONE poller on the same channel.
   */
  snapshot: HuddleMemberSnapshot;
  /**
   * THE PER-CHANNEL SEAM (S4). The voice this browser has been told to use
   * in THIS channel, if any. Injected rather than read here so
   * `speakRoute` keeps its exact contract — the override is folded into the
   * `selected` input by `resolveHuddleVoice`, which is also where a stale
   * `local-synth` row is demoted to "no selection".
   */
  voiceOverride?: HuddleVoiceOverride | null;
}): HuddleAgentSpeech {
  const { session } = useRelaySession();
  const { channelId, selfPubkey, audioPeerPubkeys, snapshot } = options;
  const [supported] = useState(speechSynthesisSupported);
  const [enabled, setEnabledState] = useState(false);
  const agentPubkeys = useMemo(
    () => botPubkeys(snapshot.members),
    [snapshot.members],
  );
  const membershipKnown = snapshot.known;

  // Live values the subscription callback must read WITHOUT reopening the
  // REQ: membership arrives after the subscription opens, and the audio
  // roster changes constantly.
  const agentPubkeysRef = useRef<ReadonlySet<string>>(agentPubkeys);
  agentPubkeysRef.current = agentPubkeys;
  const membershipKnownRef = useRef(membershipKnown);
  membershipKnownRef.current = membershipKnown;
  const audioPeersRef = useRef<readonly string[]>(audioPeerPubkeys);
  audioPeersRef.current = audioPeerPubkeys;
  const selfPubkeyRef = useRef(selfPubkey);
  selfPubkeyRef.current = selfPubkey;

  // Echo-suppression state. The ref is the SOURCE OF TRUTH for "is the
  // avatar audible right now": synthesis starts and stops update it in the
  // same task, so an STT final arriving mid-utterance sees `speaking: true`
  // even before React has re-rendered. `speaking` state below is the same
  // information as a React-declared value for the UI and for wiring.
  const speechActivityRef = useRef<AgentSpeechActivity>({
    speaking: false,
    utterances: [],
  });
  const [speaking, setSpeaking] = useState(false);
  // One disposition per speaking agent, keyed by lowercase pubkey — the
  // wiring assertion's subject (see `speakRoutes` on the interface).
  const speakRoutesRef = useRef(new Map<string, SpeakRoute>());

  /**
   * The shared agent-speech player (voice/useAgentSpeechPlayer): route
   * selection (kind-30182 selection, then this channel's override via
   * `resolveHuddleVoice`), chunking, the /tts bridge leg through a mutable
   * gain, the local-synth fallback, watchdogs and the stop token all live
   * there. This hook keeps what is huddle-specific: the subscription,
   * membership gating, roster suppression and echo-suppression records.
   */
  const player = useAgentSpeechPlayer({
    voiceOverride: options.voiceOverride ?? null,
    logTag: "[huddle-agent-speech]",
    onRoute: (pubkeyLower, route) => {
      speakRoutesRef.current.set(pubkeyLower, route);
    },
    onSpeakingChange: (next) => {
      speechActivityRef.current.speaking = next;
      setSpeaking(next);
    },
    onChunkSpoken: (chunk) => {
      // Chunk-level echo records: a sentence settles when it stops
      // sounding, which is exactly the timing the echo-hold drain
      // compares against — better than one settle time per reply.
      speechActivityRef.current.utterances = recordUtterance(
        speechActivityRef.current.utterances,
        chunk,
        Date.now(),
      );
    },
  });
  const stopSpeechNow = player.interrupt;
  const setOutputDevice = player.setOutputDevice;
  const setMuted = player.setMuted;

  const speaker = useMemo(
    () =>
      createOrderedSpeaker(async (text, speakerPubkey) => {
        await player.speak(text, speakerPubkey);
      }),
    [player],
  );

  /**
   * Streamed replies (plan VOICE_STREAMED_REPLIES_2026-10-04 §3.5): the
   * subscription's tracker plus one live queue per open stream. Held in a
   * ref so `interrupt` can cut them without reopening the REQ.
   */
  const streamsRef = useRef<{
    tracker: SpeechStreamTracker;
    queues: Map<string, SpeechQueue>;
  } | null>(null);
  const cutStreams = useCallback(() => {
    const streams = streamsRef.current;
    if (!streams) return;
    streams.tracker.cut();
    for (const queue of streams.queues.values()) queue.close();
    streams.queues.clear();
  }, []);

  const interrupt = useCallback(() => {
    // Drop the queue first: a cancelled utterance must not be followed by
    // the next one a fraction of a second later — and a cut stream must not
    // keep feeding sentences (or its final's tail) after barge-in.
    speaker.cancel();
    cutStreams();
    stopSpeechNow();
    speechActivityRef.current.speaking = false;
    setSpeaking(false);
  }, [speaker, stopSpeechNow, cutStreams]);

  const suppressedRef = useRef(false);
  const setSuppressed = useCallback(
    (next: boolean) => {
      suppressedRef.current = next;
      if (next) interrupt();
    },
    [interrupt],
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      speaker.setEnabled(next);
      if (!next) {
        // Stop mid-sentence: leaving the utterance running after the user
        // switched speech off is the whole complaint the toggle answers.
        cutStreams();
        stopSpeechNow();
      }
    },
    [speaker, stopSpeechNow, cutStreams],
  );

  useEffect(() => {
    if (!channelId) {
      return;
    }
    const seen = new Set<string>();
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const since = nowSeconds - SPEECH_REPLAY_WINDOW_SECONDS;
    // The client switch is read once per subscription; off = 24820 is not
    // even requested, and tagged finals are spoken whole (today's path).
    const streamOn = streamedRepliesEnabled();
    const tracker = createSpeechStreamTracker();
    const queues = new Map<string, SpeechQueue>();
    streamsRef.current = { tracker, queues };
    const latency = voiceLatency();

    /** Speak one whole message in order, with its latency handle. */
    const speakWhole = (
      text: string,
      pubkey: string,
      trigger: string | null,
    ) => {
      const reply = latency.reply(channelId, pubkey, "final", trigger);
      speaker.enqueueTask(() =>
        player.speak(text, pubkey, reply ? { latency: reply } : {}),
      );
    };
    /** Feed one tracker update into its stream's queue. */
    const applyUpdate = (update: StreamUpdate) => {
      let queue = queues.get(update.key);
      if (update.isNew) {
        const fresh = createSpeechQueue();
        const reply = latency.reply(
          channelId,
          update.agentPubkey,
          "stream",
          update.triggerId,
        );
        const accepted = speaker.enqueueTask(() =>
          player.speakStream(
            fresh,
            update.agentPubkey,
            reply ? { latency: reply } : {},
          ),
        );
        if (accepted === "queued") {
          queue = fresh;
          queues.set(update.key, fresh);
        }
      }
      if (!queue) return;
      for (const text of update.speak) queue.push(text);
      if (update.ended) {
        queue.close();
        queues.delete(update.key);
      }
    };

    const unsubscribe = session.subscribe(
      huddleAgentSpeechFilter(channelId, since, { segments: streamOn }),
      {
        onEvent: (event) => {
          if (seen.has(event.id)) {
            return;
          }
          seen.add(event.id);
          // Latency t0: a `[voice]` turn from ANYONE in the call, live only
          // (a replayed turn would pair with a replayed reply).
          if (
            event.kind !== AGENT_SPEECH_SEGMENT_KIND &&
            event.content.startsWith(VOICE_TURN_MARKER) &&
            event.created_at >= nowSeconds - 1
          ) {
            latency.voiceTurn(channelId, event.id);
          }
          // Stage is presenting: drop (not queue) — a backlog must not start
          // talking the moment Stage exits.
          if (suppressedRef.current) {
            return;
          }
          // FAIL-CLOSED: with no membership snapshot yet, nobody is a known
          // agent and nothing is spoken. Never "speak it and check later".
          if (!membershipKnownRef.current) {
            return;
          }
          if (event.kind === AGENT_SPEECH_SEGMENT_KIND) {
            if (
              !streamOn ||
              !isAgentSpeechSegment(
                event,
                agentPubkeysRef.current,
                selfPubkeyRef.current,
                channelId,
              ) ||
              !shouldSpeakLocally(event.pubkey, audioPeersRef.current)
            ) {
              return;
            }
            const update = tracker.onSegment(event);
            if (update) applyUpdate(update);
            return;
          }
          const eligibility = classifySpeakableAgentText(
            event,
            agentPubkeysRef.current,
            selfPubkeyRef.current,
            channelId,
          );
          if (eligibility.text === null) {
            return;
          }
          if (!shouldSpeakLocally(event.pubkey, audioPeersRef.current)) {
            return;
          }
          const trigger = speechTriggerId(event);
          if (streamOn && speechStreamIdOfFinal(event) !== null) {
            const final = tracker.onFinal(event);
            if (final === null || final.text === null) {
              if (final) queues.get(final.key)?.close();
              if (final) queues.delete(final.key);
              return;
            }
            const queue = queues.get(final.key);
            if (final.streamOpen && queue) {
              // The final fills what the stream has not said yet.
              queue.push(final.text);
              queue.close();
              queues.delete(final.key);
              return;
            }
            // Never streamed here: the whole (attachment-stripped) message.
            speakWhole(
              final.text === event.content ? eligibility.text : final.text,
              event.pubkey,
              trigger,
            );
            return;
          }
          if (streamOn && tracker.onUntagged(event)) {
            return;
          }
          speakWhole(eligibility.text, event.pubkey, trigger);
        },
      },
    );
    // Gap skips (3 s) and idle closes (90 s) for open streams.
    const poll = setInterval(() => {
      if (!tracker.hasOpenStreams()) return;
      for (const update of tracker.poll()) applyUpdate(update);
    }, 500);
    // Leaving the huddle must stop the voice mid-sentence. Without this a
    // queued reply keeps talking over whatever the user opened next.
    return () => {
      unsubscribe();
      clearInterval(poll);
      for (const queue of queues.values()) queue.close();
      queues.clear();
      if (streamsRef.current?.tracker === tracker) streamsRef.current = null;
      speaker.cancel();
      // Stop, and release the TTS context with the call (QA 2026-09-18,
      // defect 2): the room context is closed by useHuddleAudio.teardown,
      // but this one is created lazily by the player and would otherwise
      // stay open for the life of the tab, holding the output device.
      player.dispose();
    };
  }, [session, channelId, speaker, player]);

  const suppressedAgents = useMemo(
    () =>
      audioPeerPubkeys.filter((peer) => agentPubkeys.has(peer.toLowerCase())),
    [audioPeerPubkeys, agentPubkeys],
  );

  return {
    supported,
    enabled,
    setEnabled,
    agentPubkeys,
    membershipKnown,
    suppressedAgents,
    speaking,
    speechActivity: speechActivityRef,
    speakRoutes: speakRoutesRef,
    interrupt,
    setOutputDevice,
    setMuted,
    setSuppressed,
  };
}

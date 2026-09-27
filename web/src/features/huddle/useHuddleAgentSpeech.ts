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
  recordUtterance,
  type AgentSpeechActivity,
} from "./lib/voiceTranscript.ts";
import { useAgentSpeechPlayer } from "../voice/useAgentSpeechPlayer.ts";
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
   * execute), "pocket-bridge" / "eleven-bridge" (the selection names a
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

  const interrupt = useCallback(() => {
    // Drop the queue first: a cancelled utterance must not be followed by
    // the next one a fraction of a second later.
    speaker.cancel();
    stopSpeechNow();
    speechActivityRef.current.speaking = false;
    setSpeaking(false);
  }, [speaker, stopSpeechNow]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      speaker.setEnabled(next);
      if (!next) {
        // Stop mid-sentence: leaving the utterance running after the user
        // switched speech off is the whole complaint the toggle answers.
        stopSpeechNow();
      }
    },
    [speaker, stopSpeechNow],
  );

  useEffect(() => {
    if (!channelId) {
      return;
    }
    const seen = new Set<string>();
    const since = Math.floor(Date.now() / 1_000) - SPEECH_REPLAY_WINDOW_SECONDS;
    const unsubscribe = session.subscribe(
      huddleAgentSpeechFilter(channelId, since),
      {
        onEvent: (event) => {
          if (seen.has(event.id)) {
            return;
          }
          seen.add(event.id);
          // FAIL-CLOSED: with no membership snapshot yet, nobody is a known
          // agent and nothing is spoken. Never "speak it and check later".
          if (!membershipKnownRef.current) {
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
          speaker.enqueue(eligibility.text, event.pubkey);
        },
      },
    );
    // Leaving the huddle must stop the voice mid-sentence. Without this a
    // queued reply keeps talking over whatever the user opened next.
    return () => {
      unsubscribe();
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
  };
}

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
  chunkSpeakableText,
  classifySpeakableAgentText,
  createOrderedSpeaker,
  huddleAgentSpeechFilter,
  rankVoices,
  resolveProfileVoice,
  shouldSpeakLocally,
  speakRoute,
  SPEECH_REPLAY_WINDOW_SECONDS,
  type SpeakRoute,
  watchdogMs,
} from "./lib/huddleAgentSpeech.ts";
import { botPubkeys } from "./lib/huddleMembers.ts";
import {
  recordUtterance,
  type AgentSpeechActivity,
} from "./lib/voiceTranscript.ts";
import { useAgentVoiceSelections } from "../voice/hooks.ts";
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
   * "derived" (no usable selection; the pubkey draw), or
   * "pocket-selected-pending-engine" (a pocket selection, which this
   * browser cannot synthesize until the server-side engine bridge lands).
   * A ref mutated in place, like {@link speechActivity}: same-task accurate
   * the moment an utterance is built, no re-render to wait for.
   */
  speakRoutes: RefObject<ReadonlyMap<string, SpeakRoute>>;
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

  // The speak-time seam: the agents' published kind-30182 voice selections,
  // folded LWW per pubkey by the voice feature's live subscription. A ref,
  // like the values above — the speaker closure is created once and must
  // read the CURRENT selections at utterance time, because selections
  // arrive (and change) after it exists.
  const { agentVoiceSelectionFor } = useAgentVoiceSelections();
  const voiceSelectionForRef = useRef(agentVoiceSelectionFor);
  voiceSelectionForRef.current = agentVoiceSelectionFor;

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
   * The engine's voice list, RANKED (`rankVoices`) and loaded
   * asynchronously — `getVoices()` returns [] until `voiceschanged` fires.
   * A ref, not state: only the speak closure reads it, at utterance time.
   * Selection is deterministic from the agent pubkey when the agent has
   * published no voice selection; a published selection (kind 30182)
   * overrides it at speak time (`speechVoiceProfile`'s selected input),
   * so the same agent is the same voice on every call — the fix for
   * "one voice said it, half the time it was another".
   */
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!supported) {
      return;
    }
    const synth = window.speechSynthesis;
    const load = () => {
      voicesRef.current = rankVoices(synth.getVoices());
    };
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => {
      synth.removeEventListener?.("voiceschanged", load);
    };
  }, [supported]);

  /**
   * Mid-reply stop. Bumped by every disable/teardown; a running reply's
   * chunk loop checks it before each sentence, and the in-flight chunk's
   * settle is invoked immediately through `activeSettleRef` — so
   * "stop reading" stops NOW, not when the watchdog gives up on an engine
   * that fires neither onend nor onerror after `cancel()`.
   */
  const stopTokenRef = useRef(0);
  const activeSettleRef = useRef<(() => void) | null>(null);
  const stopSpeechNow = useCallback(() => {
    stopTokenRef.current += 1;
    activeSettleRef.current?.();
    activeSettleRef.current = null;
    if (speechSynthesisSupported()) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const speaker = useMemo(
    () =>
      createOrderedSpeaker(async (text, speakerPubkey) => {
        if (!speechSynthesisSupported()) {
          return;
        }
        const stopAt = stopTokenRef.current;
        // THE SEAM (D-005 / voice v1): the agent's published selection —
        // if any — decides the voice. The fold keys selections by LOWERCASE
        // pubkey, so look up with the same normalization the speech path
        // already uses. `route.profile` is always what synthesizes; the
        // disposition is what the wiring assertion reads.
        const selected = voiceSelectionForRef.current(
          speakerPubkey.toLowerCase(),
        );
        const route = speakRoute(speakerPubkey, voicesRef.current, selected);
        speakRoutesRef.current.set(speakerPubkey.toLowerCase(), route);
        const profile = route.profile;
        const voice = resolveProfileVoice(profile, voicesRef.current);
        // Sentence-sized chunks: Chromium stalls single utterances past
        // ~15 s, so a long reply must never be ONE utterance. Chunks also
        // bound the watchdog and make cancellation land between sentences.
        const chunks = chunkSpeakableText(text);
        const utterances = chunks.length > 0 ? chunks : [text];
        speechActivityRef.current.speaking = true;
        setSpeaking(true);
        try {
          for (const chunk of utterances) {
            if (stopTokenRef.current !== stopAt) {
              break;
            }
            // One chunk = one utterance, settling on EVERY path exactly
            // once: onend, onerror, its own watchdog, or a forced stop —
            // a browser that fires neither event (cancel() and
            // synthesis-failure paths do this) must not wedge the reply.
            await new Promise<void>((resolve) => {
              const utterance = new SpeechSynthesisUtterance(chunk);
              if (voice) {
                utterance.voice = voice;
              } else {
                // Voiceless path — no English voice on this system, or the
                // profile's voice vanished from the live list. Tag the text
                // English so the engine's default machinery matches the
                // words, rather than reading English through whatever
                // locale the default voice carries.
                utterance.lang = "en";
              }
              utterance.rate = profile.rate;
              utterance.pitch = profile.pitch;
              utterance.volume = 1;
              let settled = false;
              let watchdog: number | null = null;
              const finish = () => {
                if (settled) {
                  return;
                }
                settled = true;
                if (watchdog !== null) {
                  window.clearTimeout(watchdog);
                  watchdog = null;
                }
                if (activeSettleRef.current === finish) {
                  activeSettleRef.current = null;
                }
                resolve();
              };
              watchdog = window.setTimeout(finish, watchdogMs(chunk));
              utterance.onend = finish;
              utterance.onerror = finish;
              activeSettleRef.current = finish;
              window.speechSynthesis.speak(utterance);
            });
            // Chunk-level echo records: a sentence settles when it stops
            // sounding, which is exactly the timing the echo-hold drain
            // compares against — better than one settle time per reply.
            speechActivityRef.current.utterances = recordUtterance(
              speechActivityRef.current.utterances,
              chunk,
              Date.now(),
            );
          }
        } finally {
          speechActivityRef.current.speaking = false;
          setSpeaking(false);
        }
      }),
    [],
  );

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
      stopSpeechNow();
    };
  }, [session, channelId, speaker, stopSpeechNow]);

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
  };
}

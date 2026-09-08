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
  watchdogMs,
} from "./lib/huddleAgentSpeech.ts";
import { botPubkeys } from "./lib/huddleMembers.ts";
import {
  recordUtterance,
  type AgentSpeechActivity,
} from "./lib/voiceTranscript.ts";
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

  const speaker = useMemo(
    () =>
      createOrderedSpeaker(
        (text) =>
          new Promise<void>((resolve) => {
            if (!speechSynthesisSupported()) {
              resolve();
              return;
            }
            const utterance = new SpeechSynthesisUtterance(text);
            speechActivityRef.current.speaking = true;
            setSpeaking(true);
            // Settle on EVERY path, exactly once. A synthesizer that
            // errors (no voice installed, tab throttled) must not wedge
            // the queue behind it; a browser that fires NEITHER onend nor
            // onerror (cancel() and synthesis-failure paths do this) would
            // leave `speaking` stuck true and hold voice-mode finals
            // forever — so a watchdog sized to the text force-settles the
            // utterance if the events never come. Settling also records
            // the utterance on the echo ring: whatever was audible ended
            // here, and that is what an echo final matches.
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
              const activity = speechActivityRef.current;
              activity.speaking = false;
              activity.utterances = recordUtterance(
                activity.utterances,
                text,
                Date.now(),
              );
              setSpeaking(false);
              resolve();
            };
            watchdog = window.setTimeout(finish, watchdogMs(text));
            utterance.onend = finish;
            utterance.onerror = finish;
            window.speechSynthesis.speak(utterance);
          }),
      ),
    [],
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      speaker.setEnabled(next);
      if (!next && speechSynthesisSupported()) {
        // Stop mid-sentence: leaving the utterance running after the user
        // switched speech off is the whole complaint the toggle answers.
        window.speechSynthesis.cancel();
      }
    },
    [speaker],
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
      if (speechSynthesisSupported()) {
        window.speechSynthesis.cancel();
      }
    };
  }, [session, channelId, speaker]);

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
  };
}

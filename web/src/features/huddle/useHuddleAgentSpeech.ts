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
import {
  playBridgeResponse,
  type BridgeAudioContextLike,
} from "./lib/bridgeSpeech.ts";
import { speechServiceUrl } from "@/shared/lib/relay-url";
import { botPubkeys } from "./lib/huddleMembers.ts";
import {
  resolveHuddleVoice,
  type HuddleVoiceOverride,
} from "./lib/huddlePrefs.ts";
import { applySinkId } from "./lib/huddleAudioGraph.ts";
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

  // The speak-time seam: the agents' published kind-30182 voice selections,
  // folded LWW per pubkey by the voice feature's live subscription. A ref,
  // like the values above — the speaker closure is created once and must
  // read the CURRENT selections at utterance time, because selections
  // arrive (and change) after it exists.
  const { agentVoiceSelectionFor } = useAgentVoiceSelections();
  const voiceSelectionForRef = useRef(agentVoiceSelectionFor);
  voiceSelectionForRef.current = agentVoiceSelectionFor;
  // Same treatment for the channel override: the speaker closure is built
  // once and must read the CURRENT override at utterance time.
  const voiceOverrideRef = useRef<HuddleVoiceOverride | null>(
    options.voiceOverride ?? null,
  );
  voiceOverrideRef.current = options.voiceOverride ?? null;
  /** Chosen speaker + local mute for agent audio; applied to the bridge ctx. */
  const outputDeviceIdRef = useRef("");
  const mutedRef = useRef(false);

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

  // The bridge engine's AudioContext, created on first bridge speech (the
  // enable toggle is the user gesture that unlocks audio). 24 kHz preferred
  // — matching the bridge PCM — with the browser default as fallback:
  // buffers carry their own rate and are resampled either way.
  const bridgeCtxRef = useRef<BridgeAudioContextLike | null>(null);
  /** The gain every bridge piece plays through, so the mute covers the tail. */
  const bridgeGainRef = useRef<GainNode | null>(null);
  const bridgeContext = useCallback((): BridgeAudioContextLike | null => {
    if (
      typeof window === "undefined" ||
      typeof window.AudioContext === "undefined"
    ) {
      return null;
    }
    if (bridgeCtxRef.current === null) {
      let created: AudioContext;
      try {
        created = new window.AudioContext({ sampleRate: 24_000 });
      } catch {
        created = new window.AudioContext();
      }
      bridgeCtxRef.current = created as unknown as BridgeAudioContextLike;
      // One gain for agent audio, mirroring the room's: muting has to
      // silence what is already scheduled, not only what arrives next.
      try {
        const gain = created.createGain();
        gain.gain.value = mutedRef.current ? 0 : 1;
        gain.connect(created.destination);
        bridgeGainRef.current = gain;
      } catch {
        bridgeGainRef.current = null;
      }
      if (outputDeviceIdRef.current !== "") {
        void applySinkId(created, outputDeviceIdRef.current);
      }
    }
    void (bridgeCtxRef.current as unknown as AudioContext).resume?.();
    return bridgeCtxRef.current;
  }, []);

  /** Send agent audio to a chosen speaker; remembered for a later context. */
  const setOutputDevice = useCallback((deviceId: string) => {
    outputDeviceIdRef.current = deviceId;
    const ctx = bridgeCtxRef.current;
    if (ctx !== null) {
      void applySinkId(ctx, deviceId);
    }
  }, []);

  /**
   * Silence agent audio at this browser. The bridge leg goes through the
   * gain; the local-synth fallback has no graph to route, so its utterances
   * are built at volume 0 instead.
   */
  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    const gain = bridgeGainRef.current;
    if (gain) {
      gain.gain.value = muted ? 0 : 1;
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
        // already uses. `speakRoute` owns the whole decision: `route.bridge`
        // is the server-side request when one speaks (below), and
        // `route.profile` is what the local synthesizer uses otherwise; the
        // disposition is what the wiring assertion reads.
        const published = voiceSelectionForRef.current(
          speakerPubkey.toLowerCase(),
        );
        // Channel override first, then the published selection, then
        // nothing — and a stale `local-synth` row counts as nothing
        // (lib/huddlePrefs.ts).
        const selected = resolveHuddleVoice(
          voiceOverrideRef.current,
          published,
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

        // Bridge engines (pocket presets, ElevenLabs — and the DERIVED
        // default for agents with no selection, which used to be the OS
        // robot): `route.bridge` IS the decision, made by `speakRoute` —
        // execute it, or fall to the local-synth path below. A bridge
        // failure must not mute the reply — the local-synth path speaks it
        // with the derived profile and the disposition is corrected to say
        // so. A browser with no AudioContext at all corrects
        // `derived-bridge` to `derived` — the only place that disposition
        // still originates.
        const bridgeRequest = route.bridge;
        if (bridgeRequest !== null) {
          const ctx = bridgeContext();
          if (ctx !== null) {
            let bridgeFailed = false;
            try {
              for (const chunk of utterances) {
                if (stopTokenRef.current !== stopAt) {
                  break;
                }
                const bridgeUrl = speechServiceUrl("tts");
                const bridgePromise = fetch(bridgeUrl, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    engine: bridgeRequest.engine,
                    voice: bridgeRequest.voice,
                    text: chunk,
                  }),
                });
                // Same watchdog family as the synth path: a hung bridge
                // must not wedge the speaker queue.
                const raced = await Promise.race([
                  bridgePromise,
                  new Promise<never>((_, reject) => {
                    window.setTimeout(
                      () => reject(new Error("bridge fetch watchdog")),
                      watchdogMs(chunk),
                    );
                  }),
                ]);
                if (!raced.ok) {
                  throw new Error(`bridge ${raced.status}`);
                }
                await playBridgeResponse(raced, ctx, {
                  shouldStop: () => stopTokenRef.current !== stopAt,
                  ...(bridgeGainRef.current === null
                    ? {}
                    : { destination: bridgeGainRef.current }),
                });
                speechActivityRef.current.utterances = recordUtterance(
                  speechActivityRef.current.utterances,
                  chunk,
                  Date.now(),
                );
              }
            } catch (err) {
              bridgeFailed = true;
              console.warn(
                "[huddle-agent-speech] bridge failed, speaking locally",
                err,
              );
            }
            if (!bridgeFailed) {
              speechActivityRef.current.speaking = false;
              setSpeaking(false);
              return;
            }
            speakRoutesRef.current.set(speakerPubkey.toLowerCase(), {
              disposition: "bridge-error-fallback",
              profile,
              bridge: null,
            });
            // fall through: the local-synth loop below speaks this reply
          } else if (route.disposition === "derived-bridge") {
            speakRoutesRef.current.set(speakerPubkey.toLowerCase(), {
              disposition: "derived",
              profile,
              bridge: null,
            });
            // fall through: the local-synth loop below speaks this reply
          }
        }

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
              // The local fallback has no gain node to route through, so
              // the speaker mute has to land on the utterance itself.
              utterance.volume = mutedRef.current ? 0 : 1;
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
    [bridgeContext],
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
      stopSpeechNow();
      // Release the TTS context with the call (QA 2026-09-18, defect 2):
      // the room context is closed by useHuddleAudio.teardown, but this one
      // was created lazily here and stayed open for the life of the tab,
      // holding the output device after Leave.
      const ctx = bridgeCtxRef.current;
      bridgeCtxRef.current = null;
      bridgeGainRef.current = null;
      void ctx?.close?.().catch(() => {});
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
    interrupt,
    setOutputDevice,
    setMuted,
  };
}

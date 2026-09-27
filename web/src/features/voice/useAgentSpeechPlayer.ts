import { useEffect, useRef, useState } from "react";
import { speechServiceUrl } from "@/shared/lib/relay-url";
import { rankVoices } from "../huddle/lib/huddleAgentSpeech.ts";
import type { HuddleVoiceOverride } from "../huddle/lib/huddlePrefs.ts";
import { useAgentVoiceAssignments, useAgentVoiceSelections } from "./hooks.ts";
import {
  createAgentSpeechPlayer,
  type AgentSpeechPlayer,
  type AgentSpeechPlayerDeps,
} from "./lib/agentSpeechPlayer.ts";

export type {
  AgentSpeakOptions,
  AgentSpeakResult,
  AgentSpeechPlayer,
} from "./lib/agentSpeechPlayer.ts";

/**
 * One stable agent-speech player for a component's lifetime (see
 * `lib/agentSpeechPlayer.ts`). Wires the live inputs the player reads at
 * utterance time — ranked local voices, published kind-30182 selections,
 * owner kind-30183 assignments, and the optional voice override — through refs, so the player is built
 * once and never goes stale. Released on unmount.
 */
export function useAgentSpeechPlayer(
  options: {
    voiceOverride?: HuddleVoiceOverride | null;
    logTag?: string;
    onRoute?: AgentSpeechPlayerDeps["onRoute"];
    onSpeakingChange?: AgentSpeechPlayerDeps["onSpeakingChange"];
    onChunkSpoken?: AgentSpeechPlayerDeps["onChunkSpoken"];
  } = {},
): AgentSpeechPlayer {
  const { agentVoiceSelectionFor } = useAgentVoiceSelections();
  const { assignmentFor } = useAgentVoiceAssignments();
  const live = useRef({ ...options, agentVoiceSelectionFor, assignmentFor });
  live.current = { ...options, agentVoiceSelectionFor, assignmentFor };

  /**
   * The engine's voice list, RANKED and loaded asynchronously —
   * `getVoices()` returns [] until `voiceschanged` fires.
   */
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.speechSynthesis === "undefined" ||
      typeof window.SpeechSynthesisUtterance === "undefined"
    ) {
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
  }, []);

  const [player] = useState(() =>
    createAgentSpeechPlayer({
      getVoices: () => voicesRef.current,
      voiceSelectionFor: (pk) => live.current.agentVoiceSelectionFor(pk),
      voiceAssignmentFor: (pk) => live.current.assignmentFor(pk),
      getVoiceOverride: () => live.current.voiceOverride ?? null,
      ttsUrl: () => speechServiceUrl("tts"),
      logTag: options.logTag,
      onRoute: (pk, route) => live.current.onRoute?.(pk, route),
      onSpeakingChange: (s) => live.current.onSpeakingChange?.(s),
      onChunkSpoken: (c) => live.current.onChunkSpoken?.(c),
    }),
  );

  useEffect(() => () => player.dispose(), [player]);
  return player;
}

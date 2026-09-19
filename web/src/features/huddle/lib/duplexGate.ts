/**
 * Who talks while the agent is talking — the duplex gate.
 *
 * Two disciplines, chosen per channel (see `huddlePrefs.ts`):
 *
 *  HALF-DUPLEX (the default). While the agent speaks, the mic is HELD: the
 *  uplink track is disabled and the STT bridge is fed nothing, exactly as
 *  mute does it — but through a SEPARATE flag, so the user's own mute is
 *  untouched and comes back unchanged when she stops. Speakers in a room
 *  are the reason: without the hold, every reply is heard by the mic and
 *  the agent ends up in conversation with herself.
 *
 *  BARGE-IN. The mic stays hot and speaking cuts her off. The hazard is the
 *  same echo: on speakers the mic hears HER, so a naive "any transcript
 *  interrupts" rule lets the agent interrupt herself mid-sentence. Two
 *  guards, both encoded here: only an INTERIM interrupts (a final that is
 *  an echo is caught by the existing echo suppressor in
 *  `voiceTranscript.ts`, which runs after this gate), and only after the
 *  viewer's own mic has read as speaking continuously for
 *  {@link BARGE_MIC_HOT_MS} — room echo through a speaker is intermittent
 *  and rarely holds the threshold that long, a person leaning in does.
 *
 * USER MUTE OUTRANKS EVERYTHING. A muted mic cannot barge in (there is no
 * audio to barge in with), so mute suppresses the interrupt and clears the
 * hot-mic timer; and because the hold is its own flag, releasing it never
 * un-mutes anybody. The audio layer composes the two:
 * `live = !muted && !held`.
 *
 * This module is the pure reducer for all of that: state in, one event in,
 * next state plus the one effect (`interrupt`) out. The wiring — when
 * `agent_speech_end` is dispatched relative to the echo tail, what an
 * interrupt actually stops — lives in the hook. Import-free, so
 * `node --test` loads it.
 */

import type { HuddleDuplexMode } from "./huddlePrefs.ts";

export type { HuddleDuplexMode };

/**
 * How long the viewer's own mic must read as speaking before an interim
 * may interrupt the agent (ms). Sam's spec number, and it is a floor
 * against speaker echo, not a UI nicety — see the module header.
 */
export const BARGE_MIC_HOT_MS = 300;

export interface DuplexState {
  mode: HuddleDuplexMode;
  /** Is the agent audible right now (speech, or still inside the echo tail)? */
  agentSpeaking: boolean;
  /** The user's OWN mute. The gate reads it and never writes it. */
  userMuted: boolean;
  /**
   * Is the mic held by the gate? Half-duplex only, and deliberately
   * independent of {@link userMuted} so a release cannot unmute.
   */
  held: boolean;
  /**
   * When the viewer's mic last STARTED reading as speaking (ms epoch), or
   * null while it is quiet. The barge-in debounce measures from here.
   */
  micHotSince: number | null;
}

export type DuplexEvent =
  | { type: "set_mode"; mode: HuddleDuplexMode }
  | { type: "agent_speech_start" }
  | { type: "agent_speech_end" }
  | { type: "user_mute"; muted: boolean }
  | { type: "mic_level"; speaking: boolean; at: number }
  | { type: "interim"; text: string; at: number }
  /** Left the call / tore the gate down: everything back to rest. */
  | { type: "reset" };

export interface DuplexTransition {
  state: DuplexState;
  /** Cancel the agent's playback NOW. Only ever true in barge-in mode. */
  interrupt: boolean;
}

export function initialDuplexState(
  mode: HuddleDuplexMode = "half",
): DuplexState {
  return {
    mode,
    agentSpeaking: false,
    userMuted: false,
    held: false,
    micHotSince: null,
  };
}

/** Half-duplex holds whenever the agent is audible; barge-in never holds. */
function holdFor(mode: HuddleDuplexMode, agentSpeaking: boolean): boolean {
  return mode === "half" && agentSpeaking;
}

function settled(state: DuplexState): DuplexTransition {
  return { state, interrupt: false };
}

/**
 * One step of the gate.
 *
 * Pure: the same state and event always produce the same transition, and
 * nothing here reads a clock — every event that needs a time carries one.
 */
export function nextMicHold(
  state: DuplexState,
  event: DuplexEvent,
): DuplexTransition {
  switch (event.type) {
    case "set_mode": {
      if (event.mode === state.mode) {
        return settled(state);
      }
      return settled({
        ...state,
        mode: event.mode,
        held: holdFor(event.mode, state.agentSpeaking),
        // Switching discipline restarts the barge debounce: the hot streak
        // measured under the other mode says nothing about this one.
        micHotSince: null,
      });
    }
    case "agent_speech_start": {
      return settled({
        ...state,
        agentSpeaking: true,
        held: holdFor(state.mode, true),
      });
    }
    case "agent_speech_end": {
      return settled({
        ...state,
        agentSpeaking: false,
        held: false,
      });
    }
    case "user_mute": {
      return settled({
        ...state,
        userMuted: event.muted,
        // A muted mic is not hot, whatever the last level said.
        micHotSince: event.muted ? null : state.micHotSince,
      });
    }
    case "mic_level": {
      if (state.userMuted) {
        return settled(state.micHotSince === null ? state : { ...state, micHotSince: null });
      }
      if (!event.speaking) {
        return settled(
          state.micHotSince === null ? state : { ...state, micHotSince: null },
        );
      }
      // Rising edge only — a continuing hot mic keeps its original start,
      // which is what makes the streak measurable at all.
      return settled(
        state.micHotSince === null
          ? { ...state, micHotSince: event.at }
          : state,
      );
    }
    case "interim": {
      const realSpeech = event.text.trim().length > 0;
      const hotFor =
        state.micHotSince === null ? -1 : event.at - state.micHotSince;
      const interrupt =
        state.mode === "barge" &&
        state.agentSpeaking &&
        !state.userMuted &&
        realSpeech &&
        hotFor >= BARGE_MIC_HOT_MS;
      return { state, interrupt };
    }
    case "reset": {
      return settled(initialDuplexState(state.mode));
    }
  }
}

/**
 * Is the mic held by the gate right now? The audio layer composes this with
 * the user's own mute (`live = !muted && !held`) — the two are deliberately
 * not folded together here, so neither can silently overwrite the other.
 */
export function micHeld(state: DuplexState): boolean {
  return state.held;
}

/** One-line status for the dock while the gate is holding the mic. */
export function micHoldNotice(
  state: DuplexState,
  agentName: string,
): string | null {
  if (!state.held) {
    return null;
  }
  return `Mic paused while ${agentName} speaks`;
}

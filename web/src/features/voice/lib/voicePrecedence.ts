/**
 * THE voice precedence — one helper every web surface resolves through
 * (design `CHATTERBOX_ALL_VOICES_DESIGN_2026-09-27.md` §4.4):
 *
 *   effective(agent) = channelOverride   // browser-local, this room, this listener
 *                   ?? ownerAssignment   // kind 30183, relay-verified owner row
 *                   ?? agentSelf         // kind 30182, the agent's own choice
 *                   ?? derived           // pubkey draw (the caller's speakRoute)
 *
 * A `local-synth` row at the assignment or self layer counts as NONE: the
 * on-device engine was dropped from every picker, and an old row naming an
 * OS voice must not drag the robot back into a call.
 *
 * Import-free apart from TYPE-only imports, so `node --test` loads it.
 */

import type { AgentVoiceSelection } from "./agentVoiceSelection.ts";

/** Which layer decided. `derived` means nothing did. */
export type VoiceSource = "channel" | "owner" | "agent" | "derived";

export interface EffectiveVoice {
  /** `undefined` exactly when `source === "derived"`. */
  selection: AgentVoiceSelection | undefined;
  source: VoiceSource;
}

/** A per-channel override row, shape-compatible with `HuddleVoiceOverride`. */
export interface ChannelVoiceOverride {
  engine: "pocket" | "chatterbox" | "eleven";
  key: string;
}

function usable(
  selection: AgentVoiceSelection | undefined,
): AgentVoiceSelection | undefined {
  if (selection === undefined || selection.engine === "local-synth") {
    return undefined;
  }
  return selection;
}

export function resolveEffectiveVoice(layers: {
  override?: ChannelVoiceOverride | null;
  assignment?: AgentVoiceSelection;
  self?: AgentVoiceSelection;
}): EffectiveVoice {
  const { override } = layers;
  if (override !== null && override !== undefined) {
    return {
      selection: { engine: override.engine, key: override.key },
      source: "channel",
    };
  }
  const assignment = usable(layers.assignment);
  if (assignment !== undefined) {
    return { selection: assignment, source: "owner" };
  }
  const self = usable(layers.self);
  if (self !== undefined) {
    return { selection: self, source: "agent" };
  }
  return { selection: undefined, source: "derived" };
}

/** Human copy for a source chip. One spelling for every surface. */
export function voiceSourceLabel(
  source: VoiceSource,
  viewerIsOwner = false,
): string {
  switch (source) {
    case "owner":
      return viewerIsOwner ? "set by you" : "set by owner";
    case "agent":
      return "agent's choice";
    case "channel":
      return "this channel only";
    default:
      return "default";
  }
}

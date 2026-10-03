/**
 * One agent's effective voice as a UI line — `Evie (Chatterbox)` plus the
 * source that decided it. Shared by the "Agent voices" settings card and
 * the avatar hover / profile card so both say the same thing.
 *
 * Pure (type + sibling pure imports), so `node --test` loads it.
 */

import { derivedBridgeVoice } from "../../huddle/lib/bridgeSpeech.ts";
import type { AgentVoiceSelection } from "./agentVoiceSelection.ts";
import { describeVoice, type ChatterboxVoice } from "./chatterboxRoster.ts";
import {
  resolveEffectiveVoice,
  voiceSourceLabel,
  type VoiceSource,
} from "./voicePrecedence.ts";

export interface VoiceLayerRow {
  selection: AgentVoiceSelection;
  label: string;
}

export interface AgentVoiceSummary {
  /** `Label (Engine)`. */
  voice: string;
  source: VoiceSource;
  /** Chip copy: `set by you` / `set by owner` / `agent's choice` / `default`. */
  sourceLabel: string;
  /** The effective selection (`undefined` = derived default). */
  selection: AgentVoiceSelection | undefined;
}

/**
 * Resolve and describe. No channel layer: these surfaces are not in a room,
 * so the relay-level order (owner > agent > derived) is what applies.
 */
export function summarizeAgentVoice(input: {
  agentPubkey: string;
  assignment: VoiceLayerRow | undefined;
  self: VoiceLayerRow | undefined;
  roster: readonly ChatterboxVoice[];
  viewerIsOwner?: boolean;
}): AgentVoiceSummary {
  const effective = resolveEffectiveVoice({
    assignment: input.assignment?.selection,
    self: input.self?.selection,
  });
  const sourceLabel = voiceSourceLabel(
    effective.source,
    input.viewerIsOwner ?? false,
  );
  if (effective.selection === undefined) {
    const derived = derivedBridgeVoice(input.agentPubkey);
    return {
      voice: describeVoice(
        { engine: "chatterbox", key: `chatterbox:${derived.voice}` },
        input.roster,
      ),
      source: effective.source,
      sourceLabel,
      selection: undefined,
    };
  }
  const publishedLabel =
    effective.source === "owner" ? input.assignment?.label : input.self?.label;
  return {
    voice: describeVoice(effective.selection, input.roster, publishedLabel),
    source: effective.source,
    sourceLabel,
    selection: effective.selection,
  };
}

/**
 * The bridge preview request for an effective voice: its own engine, a
 * legacy pocket preset through its Chatterbox twin, and the derived
 * default (no selection) through the derived Chatterbox slug.
 */
export function previewRequestFor(
  agentPubkey: string,
  selection: AgentVoiceSelection | undefined,
): { engine: "chatterbox" | "eleven" | "fish"; key: string } {
  if (
    selection?.engine === "chatterbox" ||
    selection?.engine === "eleven" ||
    selection?.engine === "fish"
  ) {
    return { engine: selection.engine, key: selection.key };
  }
  if (selection?.engine === "pocket") {
    return {
      engine: "chatterbox",
      key: `chatterbox:${selection.key.slice("pocket:".length)}`,
    };
  }
  return {
    engine: "chatterbox",
    key: `chatterbox:${derivedBridgeVoice(agentPubkey).voice}`,
  };
}

/**
 * Relay side of voice selection.
 *
 * Thin on purpose, exactly like `ownEmojiApi.ts`: the picker decides WHAT to
 * publish; this file only signs and hands the event to the session.
 *
 *  - `publishAgentVoiceSelection` signs a kind:30182 for the LOGGED-IN
 *    identity. The author pubkey IS the voice's owner, so this binds the
 *    speaking voice of whoever is signed in ("Your voice").
 *  - `publishAgentVoiceAssignment` signs the owner's kind:30183 for one of
 *    their AGENTS (`d` = agent pubkey) — the "Agent voices" path.
 *  - `clearAgentVoiceAssignment` deletes that 30183 by coordinate.
 *
 * Content is byte-identical to the CLI's `selection_body`
 * (crates/buzz-cli/src/commands/voices.rs): `{version, engine, key|voiceURI,
 * label}`.
 */

import type { RelaySession } from "@/shared/api/relay-session";
import {
  signNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";

import {
  AGENT_VOICE_D_TAG,
  KIND_AGENT_VOICE,
  type AgentVoiceSelection,
} from "./agentVoiceSelection.ts";
import {
  KIND_AGENT_VOICE_ASSIGNMENT,
  KIND_DELETION,
  assignmentCoordinate,
} from "./agentVoiceAssignment.ts";

function selectionContent(
  selection: AgentVoiceSelection,
  label: string,
): string {
  return JSON.stringify({
    version: 1,
    engine: selection.engine,
    ...(selection.engine === "local-synth"
      ? { voiceURI: selection.voiceURI }
      : { key: selection.key }),
    label,
  });
}

/**
 * Publish (or replace) the caller's agent-voice selection.
 *
 * The `d` tag is the fixed `agent-voice` constant — ONE row per author — so
 * every publish is a NIP-33 replacement, never a second slot.
 *
 * Throws on a relay refusal rather than returning a flag: the only sensible
 * response to "the relay said no" is to surface its message, and a thrown
 * error carries it without the picker re-deriving one.
 */
export async function publishAgentVoiceSelection(
  session: RelaySession,
  selection: AgentVoiceSelection,
  label: string,
): Promise<void> {
  const event = await signNostrEvent({
    kind: KIND_AGENT_VOICE,
    content: selectionContent(selection, label),
    tags: [["d", AGENT_VOICE_D_TAG]],
  });
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(
      result.message || "The relay rejected the voice selection.",
    );
  }
}

/**
 * Publish (or replace) the signed-in OWNER's kind:30183 voice assignment
 * for one of their agents: `d` = the agent pubkey (64 lowercase hex). The
 * relay accepts it only when the signer is the agent's registered owner.
 *
 * This is the ONLY publisher the "Agent voices" surfaces call. It never
 * signs a 30182: that would bind the signed-in identity's own voice — the
 * 9/18 trap this path exists to remove.
 */
export async function publishAgentVoiceAssignment(
  session: RelaySession,
  agentPubkey: string,
  selection: AgentVoiceSelection,
  label: string,
): Promise<void> {
  const agent = agentPubkey.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(agent)) {
    throw new Error("Agent pubkey must be 64 hex characters.");
  }
  const event = await signNostrEvent({
    kind: KIND_AGENT_VOICE_ASSIGNMENT,
    content: selectionContent(selection, label),
    tags: [["d", agent]],
  });
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(
      result.message || "The relay rejected the voice assignment.",
    );
  }
}

/**
 * Clear the owner's assignment for an agent: a kind-5 `a`-tag coordinate
 * delete of `30183:<owner>:<agent>` (the CLI's `assign --clear`). Returns
 * the signed deletion so the caller can fold it locally at once.
 */
export async function clearAgentVoiceAssignment(
  session: RelaySession,
  ownerPubkey: string,
  agentPubkey: string,
): Promise<SignedNostrEvent> {
  const event = await signNostrEvent({
    kind: KIND_DELETION,
    content: "",
    tags: [["a", assignmentCoordinate(ownerPubkey, agentPubkey)]],
  });
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(result.message || "The relay rejected the reset.");
  }
  return event;
}

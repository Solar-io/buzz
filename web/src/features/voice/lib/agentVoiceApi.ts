/**
 * Relay side of "my own agent voice".
 *
 * Thin on purpose, exactly like `ownEmojiApi.ts`: the picker decides WHAT to
 * publish; this file only signs a kind:30182 for the logged-in identity and
 * hands it to the session. The author pubkey IS the agent identity, so
 * publishing here binds the speaking voice of whoever is signed in — there
 * is no per-target addressing to get wrong.
 */

import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

import {
  AGENT_VOICE_D_TAG,
  KIND_AGENT_VOICE,
  type AgentVoiceSelection,
} from "./agentVoiceSelection.ts";

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
  const content = JSON.stringify({
    version: 1,
    engine: selection.engine,
    ...(selection.engine === "local-synth"
      ? { voiceURI: selection.voiceURI }
      : { key: selection.key }),
    label,
  });
  const event = await signNostrEvent({
    kind: KIND_AGENT_VOICE,
    content,
    tags: [["d", AGENT_VOICE_D_TAG]],
  });
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(
      result.message || "The relay rejected the voice selection.",
    );
  }
}

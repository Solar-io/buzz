import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";

/** Buzz agent-voice selection (`crates/buzz-core/src/kind.rs` KIND_AGENT_VOICE). */
const KIND_AGENT_VOICE = 30182;
const AGENT_VOICE_D_TAG = "agent-voice";
const MAX_LABEL_CHARS = 128;

/**
 * Bounded display label from a 30182 body (`{version: 1, label, …}`); null for
 * anything malformed or containing control characters. The web reader
 * (`web/src/features/voice/lib/agentVoiceSelection.ts`) is the full parser;
 * the popover only needs the label.
 */
export function agentVoiceLabel(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const { version, label } = parsed as { version?: unknown; label?: unknown };
  if (version !== 1 || typeof label !== "string") {
    return null;
  }
  const trimmed = label.trim();
  if (
    trimmed.length === 0 ||
    [...trimmed].length > MAX_LABEL_CHARS ||
    [...trimmed].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return null;
  }
  return trimmed;
}

/** The agent's published voice label. Call only from an open popover body. */
export function useAgentVoiceLabel(pubkey: string, enabled: boolean) {
  return useQuery({
    queryKey: ["agent-voice-label", pubkey],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_AGENT_VOICE],
        authors: [pubkey],
        "#d": [AGENT_VOICE_D_TAG],
        limit: 1,
      });
      const event = events.find((candidate) => candidate.pubkey === pubkey);
      return event ? agentVoiceLabel(event.content) : null;
    },
  });
}

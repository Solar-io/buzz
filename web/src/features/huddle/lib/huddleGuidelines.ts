/**
 * Voice-mode guidelines for agents in a huddle, published by the WEB huddle
 * lifecycle (kind 48106).
 *
 * This is the web half of a desktop mechanism. The desktop posts these
 * guidelines to the EPHEMERAL channel at huddle start, BEFORE any agent is
 * added (desktop/src-tauri/src/huddle/mod.rs:261-272); the agent harness
 * fetches kind-48106 events signed by the agent owner and folds them into
 * the channel session's system prompt
 * (crates/buzz-acp/src/pool.rs:3029-3083 `fetch_huddle_instructions`).
 * Without them an agent still WAKES on huddle messages (the p-tagged kind-9
 * transcript is the wake), but lacks the spoken-reply protocol.
 *
 * The event shape replicates the desktop's `build_huddle_guidelines`
 * (desktop/src-tauri/src/events.rs:505-517) exactly: kind 48106, a single
 * `["h", ephemeral_channel_id]` tag, the guidelines text as content. The
 * dedicated kind is what lets the TTS pipeline filter it out "without
 * fragile content-prefix matching" (events.rs:507-509).
 *
 * The TEXT is replicated verbatim from `voice_mode_guidelines`
 * (desktop/src-tauri/src/huddle/agents.rs:37-53): it is prompt seasoning
 * shared across clients, not a place to editorialize. It references
 * `buzz messages send` because that is the agent-side tool named by the
 * desktop text; a web huddle's agents read it identically.
 *
 * DUPLICATE GUARD — same structure as the desktop's, not a query. The
 * desktop publishes guidelines only inside huddle creation (one per huddle
 * lifetime; creation refuses when a huddle is already active,
 * mod.rs:230-232) and explicitly does NOT re-post on later agent adds:
 * "the agent sees the original kind:48106 guidelines via EOSE replay when
 * it subscribes to the ephemeral channel"
 * (desktop/src-tauri/src/huddle/commands.rs:207-208). The web's
 * `startHuddle` is the only creation path and mints a fresh channel UUID
 * per call, so each publish is by construction once per huddle; joining an
 * existing huddle never re-runs it.
 *
 * Import-free apart from sibling `.ts` modules, so `node --test` loads it.
 */

/** `KIND_HUDDLE_GUIDELINES` — crates/buzz-core/src/kind.rs:666. */
export const HUDDLE_GUIDELINES_KIND = 48106;

export interface UnsignedHuddleGuidelinesEvent {
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * The guidelines text, verbatim from the desktop's `voice_mode_guidelines`
 * (agents.rs:37-53). `{parent_channel_id}` is the only interpolation.
 */
export function voiceModeGuidelines(parentChannelId: string): string {
  return `You are in a live voice huddle. Its attached main channel is ${parentChannelId}; that is not the live huddle channel.
The channel UUID in the current \`[Context]\` block is the live huddle channel. Only messages sent with \`buzz messages send\` to that current Context channel are spoken aloud, in the order sent; everything else you produce is silent.
When a user addresses you, your FIRST tool call must send a brief spoken reply to the current Context channel, before any file read, search, or other tool call. The usual rule against bare acknowledgments does not apply here; the pickup is the feedback that you heard them.
Then work, sending each useful sentence as its own message the moment it is ready—a few sentences per answer, not a monologue.
Speak plainly without markdown; post code or long detail to the attached main channel instead.
If you are not addressed, stay silent.`;
}

/**
 * One kind-48106 guidelines event for the EPHEMERAL huddle channel —
 * `build_huddle_guidelines` (desktop events.rs:510-517): tags are exactly
 * `[["h", ephemeral_channel_id]]`, content is the verbatim guidelines text.
 *
 * Refuses (rather than plans) when either id is empty, mirroring the
 * desktop's `validate_channel_id` / `check_content` guards.
 */
export function buildHuddleGuidelinesEvent(input: {
  ephemeralChannelId: string;
  parentChannelId: string;
}): { event: UnsignedHuddleGuidelinesEvent } | { error: string } {
  if (input.ephemeralChannelId.length === 0) {
    return { error: "ephemeral channel id is required" };
  }
  if (input.parentChannelId.length === 0) {
    return { error: "parent channel id is required" };
  }
  return {
    event: {
      kind: HUDDLE_GUIDELINES_KIND,
      tags: [["h", input.ephemeralChannelId]],
      content: voiceModeGuidelines(input.parentChannelId),
    },
  };
}

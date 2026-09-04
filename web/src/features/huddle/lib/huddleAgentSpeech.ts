/**
 * Agent speech in a huddle — the half of the desktop's TTS a browser can
 * actually run, and an honest boundary around the half it cannot.
 *
 * WHAT THE DESKTOP DOES, in three pieces:
 *
 *  1. SELECT. A live REQ on the ephemeral channel for message kinds
 *     (`buildHuddleTtsLiveFilter`, desktop/src/shared/api/relayChannelFilters.ts:53),
 *     then `classifySpeakableAgentText`
 *     (desktop/src/features/huddle/lib/ttsLiveMessages.ts:54): right kind,
 *     right `h`, author is a huddle agent, not self, non-empty, not
 *     `[System]`. The agent set comes from the ephemeral channel's members
 *     filtered to role `bot`.
 *  2. SYNTHESIZE. Locally, with downloaded pocket-tts models
 *     (`TTS_MODEL_DIR_NAME = "pocket-tts"`,
 *     desktop/src-tauri/src/huddle/models.rs:162) and a per-agent voice
 *     reference (`agent_voice::voice_reference_for_agent`).
 *  3. BROADCAST. `agent_tts_publisher::ensure`
 *     (desktop/src-tauri/src/huddle/agent_tts_publisher.rs:11) opens a SECOND
 *     authenticated audio socket AS THE AGENT, signing with
 *     `record.private_key_nsec` loaded from the desktop's local managed-agent
 *     store (agent_tts_publisher.rs:22-34), so every participant hears it as
 *     an ordinary room peer.
 *
 * WHAT A BROWSER CAN DO:
 *
 *  1. SELECT — yes, entirely. Every input is on the wire. The agent set does
 *     not need `get_huddle_agent_pubkeys`: the relay signs a kind-39002
 *     member snapshot whose tags are `["p", pubkey, "", role]`
 *     (`group_members_tags`, crates/buzz-relay/src/handlers/side_effects.rs:1040-1049),
 *     so `role === "bot"` is readable from a plain REQ. That is what
 *     {@link botPubkeysFromMemberEvent} decodes.
 *  2. SYNTHESIZE — yes, but DIFFERENTLY. `window.speechSynthesis` needs no
 *     model download and no permission. It is not pocket-tts, there is no
 *     per-agent voice registry, and the available voices depend on the OS.
 *  3. BROADCAST — NO. The socket is authenticated as the agent, and the
 *     agent's nsec exists only in the desktop's local store; the kind-30177
 *     registry deliberately publishes no secret ("Secrets never ride this
 *     event", web/src/features/agents/lib/agentRegistry.ts:6). There is no
 *     browser path to that key, so a browser cannot be a room speaker for an
 *     agent at all.
 *
 * So web agent speech is LOCAL PLAYBACK for the person at this browser. Which
 * creates the one hazard this module exists to handle: if a desktop in the
 * same huddle IS broadcasting, that agent shows up as an ordinary audio peer
 * and the browser would hear the sentence twice — once over the wire, once
 * from its own synthesizer. {@link shouldSpeakLocally} suppresses the local
 * copy for any agent currently present in the room's audio roster.
 *
 * Import-free apart from sibling `.ts` modules, so `node --test` loads it.
 */

import {
  botPubkeys,
  membersFromMemberEvent,
  type MemberSnapshotEventLike,
} from "./huddleMembers.ts";

export {
  GROUP_MEMBERS_KIND,
  huddleMemberSnapshotFilter,
} from "./huddleMembers.ts";

/**
 * `KIND_STREAM_MESSAGE` (9) and `KIND_STREAM_MESSAGE_V2` (40002) —
 * crates/buzz-core/src/kind.rs:504 and :506. The same pair the desktop's TTS
 * filter uses; edits, diffs and forum posts are deliberately not spoken.
 */
export const SPEAKABLE_MESSAGE_KINDS = [9, 40002];

/**
 * Replay window on the live subscription, in seconds.
 *
 * The desktop's `TTS_STARTUP_REPLAY_WINDOW_SECONDS`
 * (desktop/src/features/huddle/lib/useTtsSubscription.ts:22): the first agent
 * reply can land while the membership snapshot is still loading, so a few
 * seconds of stored replay recovers it without reading out chat history.
 */
export const SPEECH_REPLAY_WINDOW_SECONDS = 5;

export interface SpeechEventLike {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
}

export type SpeechRejection =
  | "unsupported_kind"
  | "h_tag_mismatch"
  | "author_not_agent"
  | "self_authored"
  | "empty_or_system";

export type SpeechEligibility =
  | { text: string; reason: null }
  | { text: null; reason: SpeechRejection };

/**
 * Strip attachment markdown so the synthesizer does not read a URL aloud.
 * Ported from the desktop's `textWithoutAttachments`
 * (ttsLiveMessages.ts:31) — same `imeta` handling, same empty-spoiler cleanup.
 */
export function textWithoutAttachments(event: SpeechEventLike): string {
  const urls = new Set(
    event.tags
      .filter((tag) => tag[0] === "imeta")
      .flatMap((tag) =>
        tag
          .slice(1)
          .filter((field) => field.startsWith("url "))
          .map((field) => field.slice(4)),
      ),
  );
  if (urls.size === 0) {
    return event.content;
  }
  const withoutMedia = event.content
    .split("\n")
    .filter(
      (line) => !Array.from(urls).some((url) => line.includes(`](${url})`)),
    )
    .join("\n");
  return withoutMedia.replace(
    /(^|\n)\s*\|\|\s*\n(?:\s*\n)*\s*\|\|\s*(?=\n|$)/gu,
    "$1",
  );
}

/**
 * Is this event a huddle agent saying something out loud?
 *
 * FAIL-CLOSED on membership, exactly as the desktop is: an empty
 * `agentPubkeys` means "no agents known", never "speak everything". The
 * caller must not call this before it has a membership snapshot.
 */
export function classifySpeakableAgentText(
  event: SpeechEventLike,
  agentPubkeys: ReadonlySet<string>,
  selfPubkey: string | null,
  channelId: string,
): SpeechEligibility {
  if (!SPEAKABLE_MESSAGE_KINDS.includes(event.kind)) {
    return { text: null, reason: "unsupported_kind" };
  }
  if (!event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId)) {
    return { text: null, reason: "h_tag_mismatch" };
  }
  const author = event.pubkey.toLowerCase();
  if (!agentPubkeys.has(author)) {
    return { text: null, reason: "author_not_agent" };
  }
  if (selfPubkey !== null && author === selfPubkey.toLowerCase()) {
    return { text: null, reason: "self_authored" };
  }
  const content = textWithoutAttachments(event).trim();
  if (content.length === 0 || content.startsWith("[System]")) {
    return { text: null, reason: "empty_or_system" };
  }
  return { text: content, reason: null };
}

/**
 * The bot members of one relay-signed kind-39002 snapshot — a huddle's
 * agents, and therefore exactly the authors whose messages may be spoken.
 *
 * Null when the event is not this channel's snapshot, so a caller cannot
 * mistake "different channel" for "no bots" and go silent — or worse, adopt
 * another room's agent list. The parse lives in `huddleMembers.ts`; the role
 * is tag index 3, past the empty relay url.
 */
export function botPubkeysFromMemberEvent(
  event: MemberSnapshotEventLike,
  channelId: string,
): Set<string> | null {
  const members = membersFromMemberEvent(event, channelId);
  return members === null ? null : botPubkeys(members);
}

/**
 * Should THIS browser synthesize the sentence itself?
 *
 * No, when the speaking agent is already in the room's audio roster: some
 * desktop is broadcasting its pocket-tts voice as a peer and the browser is
 * about to hear the same words over the wire. Speaking anyway is the
 * double-audio bug, and it is not hypothetical — the desktop publisher joins
 * under the agent's own pubkey (`connect_tts_audio_publisher`,
 * desktop/src-tauri/src/huddle/relay_api.rs:316), so the agent appears in the
 * roster exactly like a person.
 */
export function shouldSpeakLocally(
  speakerPubkey: string,
  audioPeerPubkeys: readonly string[],
): boolean {
  const speaker = speakerPubkey.toLowerCase();
  return !audioPeerPubkeys.some((peer) => peer.toLowerCase() === speaker);
}

/** The live REQ filter for speakable agent messages in one huddle. */
export function huddleAgentSpeechFilter(
  channelId: string,
  sinceSeconds: number,
): { kinds: number[]; "#h": string[]; since: number; limit: number } {
  return {
    kinds: [...SPEAKABLE_MESSAGE_KINDS],
    "#h": [channelId],
    since: sinceSeconds,
    limit: 50,
  };
}

export interface OrderedSpeaker {
  /** Queue one utterance. Returns whether it was accepted. */
  enqueue: (text: string, speakerPubkey: string) => "queued" | "disabled";
  /** Turning speech off cancels everything still queued. */
  setEnabled: (enabled: boolean) => void;
  /** Drop everything queued without changing the enabled flag. */
  cancel: () => void;
}

/**
 * Serialize utterances so they are spoken in arrival order.
 *
 * Ported from the desktop's `createOrderedSpeaker` (ttsLiveMessages.ts:99),
 * with its generation counter: disabling speech bumps the generation, so
 * anything already queued behind an in-flight utterance is dropped rather
 * than spoken after the user has switched it off.
 */
export function createOrderedSpeaker(
  speak: (text: string, speakerPubkey: string) => Promise<void>,
  onError: (error: unknown) => void = () => {},
  initiallyEnabled = false,
): OrderedSpeaker {
  let tail = Promise.resolve();
  let enabled = initiallyEnabled;
  let generation = 0;
  return {
    enqueue(text, speakerPubkey) {
      if (!enabled) {
        return "disabled";
      }
      const queuedGeneration = generation;
      tail = tail
        .then(() => {
          if (!enabled || generation !== queuedGeneration) {
            return;
          }
          return speak(text, speakerPubkey);
        })
        .catch(onError);
      return "queued";
    },
    setEnabled(nextEnabled) {
      if (!nextEnabled) {
        generation += 1;
      }
      enabled = nextEnabled;
    },
    cancel() {
      generation += 1;
    },
  };
}

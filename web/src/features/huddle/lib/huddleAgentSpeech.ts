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
 * Import-free apart from sibling `.ts` modules and one TYPE-only import
 * (the kind-30182 selection contract — erased at runtime), so `node --test`
 * loads it.
 */

import {
  botPubkeys,
  membersFromMemberEvent,
  type MemberSnapshotEventLike,
} from "./huddleMembers.ts";
import type { AgentVoiceSelection } from "../../voice/lib/agentVoiceSelection.ts";

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

/** Watchdog estimate: an upper bound on spoken milliseconds per character. */
export const WATCHDOG_MS_PER_CHAR = 90;
/** Watchdog slack: engine warmup and pauses, added to the length estimate. */
export const WATCHDOG_SLACK_MS = 5_000;

/**
 * How long to wait before force-settling an utterance whose end and error
 * events never fired. Some browsers fire NEITHER `onend` nor `onerror` —
 * `speechSynthesis.cancel()` and synthesis-failure paths are the known
 * offenders — and without a backstop the caller's speaking flag sticks
 * true forever. Sized so natural speech always finishes first: roughly
 * 90 ms per character plus fixed slack.
 */
export function watchdogMs(text: string): number {
  return text.length * WATCHDOG_MS_PER_CHAR + WATCHDOG_SLACK_MS;
}

/**
 * The voice half of "centralized voice configuration", browser edition.
 *
 * A browser cannot run pocket-tts (the desktop's engine) or reach the
 * agent key needed to broadcast as a peer, so web agent speech is
 * `speechSynthesis` — and until this module, NOTHING ever set a voice:
 * every agent spoke as whatever the OS default happened to be, which is
 * the direct cause of "one voice said it yesterday, a different one
 * today". Selection here is DETERMINISTIC from the agent's pubkey, so
 * the same agent is the same voice on every call and (for a given
 * browser/OS voice set) on every machine. When the huddle TTS bridge
 * lands server-side, this is the seam it replaces: same inputs, same
 * per-agent profile shape, different engine behind it.
 */

/** The subset of `SpeechSynthesisVoice` selection depends on. */
export interface SpeechVoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  voiceURI: string;
}

/**
 * Rank a voice list for agent speech: local voices first (network voices
 * add round-trip latency to the first syllable), English first (huddles
 * are English today), then a stable name order so identical voice sets
 * rank identically everywhere. Returns a sorted copy; the input is not
 * mutated.
 */
export function rankVoices<T extends SpeechVoiceLike>(
  voices: readonly T[],
): T[] {
  return voices
    .map((voice, index) => ({ voice, index }))
    .sort((a, b) => {
      const rank = (voice: SpeechVoiceLike) =>
        (voice.localService ? 0 : 2) +
        (voice.lang.toLowerCase().startsWith("en") ? 0 : 1);
      const byClass = rank(a.voice) - rank(b.voice);
      if (byClass !== 0) {
        return byClass;
      }
      const byName = a.voice.name.localeCompare(b.voice.name);
      if (byName !== 0) {
        return byName;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.voice);
}

/** FNV-1a, 32-bit — a stable, dependency-free string hash. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned so `%` stays in [0, 2**32) across engines.
  return hash >>> 0;
}

/**
 * Below this many usable voices, agents would collide onto the same voice;
 * instead they keep the shared voice and get a stable PITCH offset, so a
 * two-agent huddle is still distinguishable by ear on a voice-poor system.
 */
export const VOICE_PITCH_SPREAD_BELOW = 3;

/** Pitch offsets spread across [0.85, 1.15] when voices are scarce. */
const PITCH_SPREAD_MIN = 0.85;

/**
 * Which input produced a profile's voice — the seam's observable verdict,
 * so a wiring assertion can check WHICH path spoke rather than merely that
 * a voice was named (a green e2e once stayed green through a Korean-voice
 * bug because a named voice was all it asserted).
 *
 *  - `selected`: the agent's published kind-30182 selection resolved
 *    against the live voice list and is speaking.
 *  - `selected-rejected`: a selection EXISTS but is unspeakable here —
 *    the voiceURI is not in the live list, or it names a non-English
 *    voice — so the derived profile speaks instead. Never silent: the
 *    source records the rejection.
 *  - `derived`: no selection at all; the deterministic pubkey draw.
 *
 * A pocket selection is none of these: the profile that actually
 * synthesizes is `derived`, and the pocket disposition lives on the
 * {@link SpeakRoute} (`pocket-selected-pending-engine`).
 */
export type AgentVoiceProfileSource =
  | "selected"
  | "selected-rejected"
  | "derived";

export interface AgentVoiceProfile {
  /**
   * Index into the ENGLISH selection pool this profile was derived from —
   * diagnostic only. Live voice resolution goes through
   * {@link resolveProfileVoice} and never indexes the list.
   */
  voiceIndex: number;
  /** Spoken rate, pinned so OS/browser defaults cannot drift per machine. */
  rate: number;
  /**
   * Pitch, 1.0 whenever the voice list is rich enough to differentiate
   * agents by voice; a stable per-agent offset otherwise.
   */
  pitch: number;
  /** The voice URI to hand `SpeechSynthesisUtterance`, or null if none. */
  voiceURI: string | null;
  /** Which input spoke — see {@link AgentVoiceProfileSource}. */
  source: AgentVoiceProfileSource;
}

/**
 * The English invariant, as ONE predicate: huddle speech is English text,
 * and a non-English voice reads it as unintelligible murmur. The derived
 * pool filter and the speak-time seam's rejection rule both call this —
 * the picker enforces it too (`ENGLISH_ONLY` in voicePickerOptions.ts),
 * and this module enforces it independently at speak time.
 */
function isEnglishVoice(voice: SpeechVoiceLike): boolean {
  return voice.lang.toLowerCase().startsWith("en");
}

/**
 * Deterministically derive one agent's speaking profile from its pubkey
 * and the RANKED available voices (`rankVoices` output), drawing only
 * from the English voices: huddle speech is English text, and a
 * non-English voice reads it as the unintelligible murmur this function
 * exists to prevent. The English set is a FILTER of the ranked list, not
 * a head slice — `rankVoices` ranks local non-English voices (tier 1)
 * ahead of remote English ones (tier 2), so the English block is
 * contiguous only by accident of the machine's voice list.
 *
 * With no English voice at all, or an empty list, returns rate/pitch
 * defaults with `voiceURI: null` — the engine default speaks (the hook
 * tags that utterance `lang="en"`), but chunking and watchdogs still
 * apply. Pitch spread keys on the POOL size, not the list size: a
 * machine with 180 voices and 2 English ones is voice-poor for exactly
 * this purpose.
 *
 * This is the base case of the speak-time seam: every fallback route
 * ({@link speakRoute}) synthesizes THIS profile, and a two-argument call
 * is exactly the pre-seam behavior with `source: "derived"`.
 */
function deriveVoiceProfile(
  pubkey: string,
  rankedVoices: readonly SpeechVoiceLike[],
): AgentVoiceProfile {
  const seed = fnv1a(pubkey.toLowerCase());
  if (rankedVoices.length === 0) {
    return {
      voiceIndex: 0,
      rate: 1,
      pitch: 1,
      voiceURI: null,
      source: "derived",
    };
  }
  const pool = rankedVoices.filter(isEnglishVoice);
  if (pool.length === 0) {
    return {
      voiceIndex: 0,
      rate: 1,
      pitch: 1,
      voiceURI: null,
      source: "derived",
    };
  }
  const voiceIndex = seed % pool.length;
  const voice = pool[voiceIndex];
  const pitch =
    pool.length < VOICE_PITCH_SPREAD_BELOW
      ? PITCH_SPREAD_MIN + ((seed >>> 8) % 31) / 100
      : 1;
  return {
    voiceIndex,
    rate: 1,
    pitch,
    voiceURI: voice.voiceURI || voice.name,
    source: "derived",
  };
}

/**
 * Why one utterance is being voiced the way it is — the speak-time seam's
 * full disposition. `profile` is the profile for LOCAL synthesis; the
 * disposition says what actually speaks.
 *
 *  - `selected`: the published local-synth voice resolved and speaks.
 *  - `selected-rejected`: the selection is unusable here (voiceURI not in
 *    the live list, or it names a non-English voice) and the derived
 *    profile speaks instead. The rejection is recorded, never silent.
 *  - `derived`: no selection; the deterministic pubkey draw.
 *  - `pocket-bridge` / `eleven-bridge`: the agent's selection names a
 *    server-side engine the tts bridge runs — the utterance synthesizes
 *    through `bridgeSpeech.ts`, NOT through speechSynthesis, and the
 *    local profile is irrelevant (kept for interface stability).
 *  - `pocket-selected-pending-engine`: an IMPORTED pocket key
 *    (`pocket:imported:<hash>`), which the bridge cannot synthesize yet —
 *    the derived profile speaks, visibly marked rather than honored.
 */
export type SpeakDisposition =
  | "selected"
  | "selected-rejected"
  | "derived"
  | "pocket-bridge"
  | "eleven-bridge"
  | "pocket-selected-pending-engine"
  | "bridge-error-fallback";

export interface SpeakRoute {
  disposition: SpeakDisposition;
  /** The profile to synthesize this utterance with — always present. */
  profile: AgentVoiceProfile;
}

/**
 * Route one agent's utterance to a voice, honoring its published kind-30182
 * selection when one exists (`AgentVoiceSelection`, the exact shape the
 * selection store folds and the picker publishes).
 *
 * Resolution discipline is `resolveProfileVoice`'s, shared with the derived
 * path: the selected `voiceURI` is matched against the LIVE ranked list by
 * URI (`voiceURI || name`), never positionally — an index into a stale list
 * is the drift class that put Slovenian voices on English agents. A
 * selection that resolves but fails the English invariant is rejected with
 * the source marking it (`selected-rejected`), because a picker-published
 * French voice reading English text is the exact murmur this module exists
 * to prevent — the picker enforces English-only at CHOICE time
 * (voicePickerOptions.ts `ENGLISH_ONLY`), and this is the same invariant
 * enforced independently at SPEAK time.
 *
 * A pocket selection is explicit: it names a server-side voice this engine
 * cannot run, so the derived profile synthesizes and the disposition says
 * `pocket-selected-pending-engine` rather than pretending the pocket voice
 * was honored.
 */
export function speakRoute(
  pubkey: string,
  rankedVoices: readonly SpeechVoiceLike[],
  selected?: AgentVoiceSelection,
): SpeakRoute {
  const derived = (): AgentVoiceProfile =>
    deriveVoiceProfile(pubkey, rankedVoices);
  if (selected === undefined) {
    return { disposition: "derived", profile: derived() };
  }
  if (selected.engine === "pocket") {
    return {
      disposition: selected.key.startsWith("pocket:imported:")
        ? "pocket-selected-pending-engine"
        : "pocket-bridge",
      profile: derived(),
    };
  }
  if (selected.engine === "eleven") {
    return {
      disposition: "eleven-bridge",
      profile: derived(),
    };
  }
  const selectedURI = selected.voiceURI;
  const resolved = rankedVoices.find(
    (voice) => (voice.voiceURI || voice.name) === selectedURI,
  );
  if (resolved === undefined || !isEnglishVoice(resolved)) {
    // The rejection is recorded ON the profile that speaks, not only on
    // the route — a wiring assertion reading either sees it.
    return {
      disposition: "selected-rejected",
      profile: { ...derived(), source: "selected-rejected" },
    };
  }
  return {
    disposition: "selected",
    profile: {
      // Diagnostic, consistent with the derived meaning: the selected
      // voice's position in the English pool. Resolution never uses it.
      voiceIndex: poolIndexOfURI(rankedVoices, selectedURI),
      // The user chose this voice; it speaks at natural settings rather
      // than the derived pitch-spread (which exists to differentiate agents
      // who did NOT choose).
      rate: 1,
      pitch: 1,
      voiceURI: resolved.voiceURI || resolved.name,
      source: "selected",
    },
  };
}

/** The selected voice's index within the English pool — diagnostic only. */
function poolIndexOfURI(
  rankedVoices: readonly SpeechVoiceLike[],
  uri: string,
): number {
  return rankedVoices
    .filter(isEnglishVoice)
    .findIndex((voice) => (voice.voiceURI || voice.name) === uri);
}

/**
 * The profile for one agent's utterance: its published selection when that
 * selection is usable here, the deterministic pubkey draw otherwise. The
 * two-argument form is exactly the pre-seam behavior; the optional third
 * argument (`selected`, from `useAgentVoiceSelections`) is the seam. See
 * {@link speakRoute} for the full disposition — callers that need to know
 * WHICH path spoke (wiring assertions, UI) should call {@link speakRoute}
 * directly.
 */
export function speechVoiceProfile(
  pubkey: string,
  rankedVoices: readonly SpeechVoiceLike[],
  selected?: AgentVoiceSelection,
): AgentVoiceProfile {
  return speakRoute(pubkey, rankedVoices, selected).profile;
}

/**
 * Resolve a derived profile against the LIVE voice list. One
 * implementation of one selection: the profile's `voiceURI` is the only
 * key, so a voice that vanished between sessions (user uninstalls it,
 * engine reshuffles) degrades to the voiceless path deliberately — it
 * can never silently fall back to `voices[voiceIndex]`, which would
 * select an unrelated, possibly non-English voice. That index fallback
 * is the drift class that gave agents Slovenian voices while the
 * profile said otherwise.
 */
export function resolveProfileVoice<T extends SpeechVoiceLike>(
  profile: AgentVoiceProfile,
  voices: readonly T[],
): T | undefined {
  if (profile.voiceURI === null) {
    return undefined;
  }
  return voices.find(
    (entry) => (entry.voiceURI || entry.name) === profile.voiceURI,
  );
}

/**
 * Chunk cap. Chromium's speechSynthesis stalls on single utterances
 * longer than ~15 s; at typical rates 200 characters is comfortably under
 * that while keeping sentence units whole.
 */
export const CHUNK_MAX_CHARS = 200;

/**
 * Split speakable text into utterance-sized chunks: sentence boundaries
 * preferred, word boundaries when a sentence alone exceeds the cap, hard
 * split only when a single "word" does. Order-preserving, never emits
 * empty chunks, and only trims the boundaries it created — the joined
 * chunks are the original text's content.
 */
export function chunkSpeakableText(
  text: string,
  maxChars = CHUNK_MAX_CHARS,
): string[] {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return [];
  }
  // Sentence-ish split: content up to and including terminal punctuation,
  // with the following whitespace peeled into the separator.
  const sentences = normalized.match(/[^.!?…]+[.!?…]+(?:\s+|$)|[^.!?…]+$/g) ?? [
    normalized,
  ];
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      chunks.push(trimmed);
    }
    current = "";
  };
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (piece.length === 0) {
      continue;
    }
    if (piece.length > maxChars) {
      // Oversize sentence: flush what we have, then word-split it.
      pushCurrent();
      let rest = piece;
      while (rest.length > maxChars) {
        const slice = rest.slice(0, maxChars);
        const cut = slice.lastIndexOf(" ");
        if (cut <= 0) {
          chunks.push(rest.slice(0, maxChars));
          rest = rest.slice(maxChars);
        } else {
          chunks.push(slice.slice(0, cut).trim());
          rest = rest.slice(cut);
        }
      }
      current = rest.trim();
      continue;
    }
    if (current.length === 0) {
      current = piece;
    } else if (current.length + 1 + piece.length <= maxChars) {
      current = `${current} ${piece}`;
    } else {
      pushCurrent();
      current = piece;
    }
  }
  pushCurrent();
  return chunks;
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

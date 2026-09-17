import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botPubkeysFromMemberEvent,
  chunkSpeakableText,
  classifySpeakableAgentText,
  CHUNK_MAX_CHARS,
  createOrderedSpeaker,
  fnv1a,
  GROUP_MEMBERS_KIND,
  huddleAgentSpeechFilter,
  huddleMemberSnapshotFilter,
  rankVoices,
  resolveProfileVoice,
  shouldSpeakLocally,
  speechVoiceProfile,
  SPEAKABLE_MESSAGE_KINDS,
  SPEECH_REPLAY_WINDOW_SECONDS,
  textWithoutAttachments,
  VOICE_PITCH_SPREAD_BELOW,
  watchdogMs,
  WATCHDOG_MS_PER_CHAR,
  WATCHDOG_SLACK_MS,
} from "./huddleAgentSpeech.ts";

const AGENT = "a".repeat(64);
const OTHER_AGENT = "b".repeat(64);
const HUMAN = "c".repeat(64);
const CHANNEL = "eph-1";
const agents = new Set([AGENT, OTHER_AGENT]);

function message(overrides = {}) {
  return {
    id: "e".repeat(64),
    kind: 40002,
    pubkey: AGENT,
    content: "Ready when you are.",
    tags: [["h", CHANNEL]],
    ...overrides,
  };
}

test("the speakable kinds are the message kinds, hardcoded", () => {
  assert.deepEqual(SPEAKABLE_MESSAGE_KINDS, [9, 40002]);
  assert.equal(GROUP_MEMBERS_KIND, 39002);
  assert.equal(SPEECH_REPLAY_WINDOW_SECONDS, 5);
});

test("an agent message in this channel is speakable", () => {
  const result = classifySpeakableAgentText(message(), agents, HUMAN, CHANNEL);
  assert.equal(result.reason, null);
  assert.equal(result.text, "Ready when you are.");
});

test("kind 9 is speakable as well as kind 40002", () => {
  const result = classifySpeakableAgentText(
    message({ kind: 9 }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, null);
});

test("a message edit is not spoken", () => {
  // 40003 is KIND_STREAM_MESSAGE_EDIT — a real neighbouring kind that shares
  // the channel, not an invented one.
  const result = classifySpeakableAgentText(
    message({ kind: 40003 }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "unsupported_kind");
  assert.equal(result.text, null);
});

test("a message for a DIFFERENT channel is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ tags: [["h", "eph-2"]] }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "h_tag_mismatch");
});

test("a human's message is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ pubkey: HUMAN }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "author_not_agent");
});

test("membership is fail-closed: an empty agent set speaks nothing", () => {
  const result = classifySpeakableAgentText(
    message(),
    new Set(),
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "author_not_agent");
});

test("your own message is never read back to you", () => {
  // selfPubkey === the author, and the author IS a known agent — so only the
  // self-check can reject this. Discriminating by construction.
  const result = classifySpeakableAgentText(message(), agents, AGENT, CHANNEL);
  assert.equal(result.reason, "self_authored");
});

test("self matching is case-insensitive", () => {
  const result = classifySpeakableAgentText(
    message({ pubkey: AGENT.toUpperCase() }),
    agents,
    AGENT,
    CHANNEL,
  );
  assert.equal(result.reason, "self_authored");
});

test("an empty message is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ content: "   \n  " }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "empty_or_system");
});

test("a [System] notice is not spoken", () => {
  const result = classifySpeakableAgentText(
    message({ content: "[System] agent restarted" }),
    agents,
    HUMAN,
    CHANNEL,
  );
  assert.equal(result.reason, "empty_or_system");
});

test("attachment markdown is stripped before speaking", () => {
  const event = message({
    content: "Here it is\n[shot.png](https://relay.example/media/abc)",
    tags: [
      ["h", CHANNEL],
      ["imeta", "url https://relay.example/media/abc", "m image/png"],
    ],
  });
  assert.equal(textWithoutAttachments(event).trim(), "Here it is");
  const result = classifySpeakableAgentText(event, agents, HUMAN, CHANNEL);
  assert.equal(result.text, "Here it is");
});

test("a message with no imeta tag keeps its content verbatim", () => {
  const event = message({ content: "[link](https://example.com/x)" });
  assert.equal(textWithoutAttachments(event), "[link](https://example.com/x)");
});

test("a message that is ONLY an attachment becomes unspeakable", () => {
  const event = message({
    content: "[shot.png](https://relay.example/media/abc)",
    tags: [
      ["h", CHANNEL],
      ["imeta", "url https://relay.example/media/abc"],
    ],
  });
  const result = classifySpeakableAgentText(event, agents, HUMAN, CHANNEL);
  assert.equal(result.reason, "empty_or_system");
});

test("bot members are read out of a 39002 snapshot by role, not position", () => {
  const bots = botPubkeysFromMemberEvent(
    {
      kind: 39002,
      tags: [
        ["d", CHANNEL],
        ["p", HUMAN, "", "member"],
        ["p", AGENT, "", "bot"],
        ["p", OTHER_AGENT, "", "admin"],
      ],
    },
    CHANNEL,
  );
  // Only the "bot" row: a member and an admin sit either side of it, so a
  // reader that took every p tag, or took the wrong index, fails here.
  assert.deepEqual([...bots], [AGENT]);
});

test("the role is index 3, past the empty relay url", () => {
  // A snapshot whose role sits at index 2 must NOT be accepted: that is the
  // shape a reader gets wrong, and the relay never emits it.
  const bots = botPubkeysFromMemberEvent(
    {
      kind: 39002,
      tags: [
        ["d", CHANNEL],
        ["p", AGENT, "bot"],
      ],
    },
    CHANNEL,
  );
  assert.equal(bots.size, 0);
});

test("another channel's member snapshot is rejected, not read as empty", () => {
  assert.equal(
    botPubkeysFromMemberEvent(
      {
        kind: 39002,
        tags: [
          ["d", "eph-2"],
          ["p", AGENT, "", "bot"],
        ],
      },
      CHANNEL,
    ),
    null,
  );
});

test("a non-39002 event is not a member snapshot", () => {
  assert.equal(
    botPubkeysFromMemberEvent(
      {
        kind: 39000,
        tags: [
          ["d", CHANNEL],
          ["p", AGENT, "", "bot"],
        ],
      },
      CHANNEL,
    ),
    null,
  );
});

test("bot pubkeys are normalised to lowercase", () => {
  const bots = botPubkeysFromMemberEvent(
    {
      kind: 39002,
      tags: [
        ["d", CHANNEL],
        ["p", AGENT.toUpperCase(), "", "bot"],
      ],
    },
    CHANNEL,
  );
  assert.ok(bots.has(AGENT));
});

test("an agent already in the audio room is not spoken locally", () => {
  // A desktop is broadcasting its pocket-tts voice as a peer; speaking here
  // too is the double-audio bug.
  assert.equal(shouldSpeakLocally(AGENT, [HUMAN, AGENT]), false);
});

test("an agent absent from the audio room IS spoken locally", () => {
  // Same call, different roster — the two cases must not agree.
  assert.equal(shouldSpeakLocally(AGENT, [HUMAN, OTHER_AGENT]), true);
});

test("audio-peer suppression is case-insensitive", () => {
  assert.equal(shouldSpeakLocally(AGENT, [AGENT.toUpperCase()]), false);
});

test("an empty audio roster suppresses nothing", () => {
  assert.equal(shouldSpeakLocally(AGENT, []), true);
});

test("the speech filter is channel-scoped by #h", () => {
  const filter = huddleAgentSpeechFilter(CHANNEL, 1_787_800_000);
  assert.deepEqual(filter["#h"], [CHANNEL]);
  assert.deepEqual(filter.kinds, [9, 40002]);
  assert.equal(filter.since, 1_787_800_000);
});

test("the member-snapshot filter keys on #d, the addressable coordinate", () => {
  const filter = huddleMemberSnapshotFilter(CHANNEL);
  assert.deepEqual(filter["#d"], [CHANNEL]);
  assert.deepEqual(filter.kinds, [39002]);
});

test("the ordered speaker starts disabled and refuses work", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    spoken.push(text);
  });
  assert.equal(speaker.enqueue("one", AGENT), "disabled");
  await Promise.resolve();
  assert.deepEqual(spoken, []);
});

test("enabled utterances are spoken in arrival order", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    // Resolve out of order on purpose: a naive implementation that fired
    // these concurrently would record "two" first.
    await new Promise((resolve) =>
      setTimeout(resolve, text === "one" ? 20 : 0),
    );
    spoken.push(text);
  });
  speaker.setEnabled(true);
  assert.equal(speaker.enqueue("one", AGENT), "queued");
  assert.equal(speaker.enqueue("two", AGENT), "queued");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(spoken.length, 2);
  assert.deepEqual(spoken, ["one", "two"]);
});

test("disabling mid-queue lets the in-flight utterance finish and drops the rest", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    spoken.push(text);
  });
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  // Let "one" actually enter speak() before the queue is torn down: the
  // generation check runs when an entry STARTS, so a still-pending entry is
  // dropped and only a started one survives.
  await new Promise((resolve) => setTimeout(resolve, 5));
  speaker.enqueue("two", AGENT);
  speaker.setEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(spoken.length, 1);
  assert.deepEqual(spoken, ["one"]);
});

test("disabling before anything starts drops the whole queue", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    spoken.push(text);
  });
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  speaker.enqueue("two", AGENT);
  speaker.setEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(spoken.length, 0);
});

test("cancel drops the queue without disabling future speech", async () => {
  const spoken = [];
  const speaker = createOrderedSpeaker(async (text) => {
    spoken.push(text);
  });
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  speaker.enqueue("two", AGENT);
  speaker.cancel();
  // Still enabled: the next utterance is accepted AND spoken, which is what
  // separates cancel() from setEnabled(false).
  assert.equal(speaker.enqueue("three", AGENT), "queued");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(spoken, ["three"]);
});

test("a throwing speak call does not wedge the queue", async () => {
  const spoken = [];
  const errors = [];
  const speaker = createOrderedSpeaker(
    async (text) => {
      if (text === "one") throw new Error("voice unavailable");
      spoken.push(text);
    },
    (error) => errors.push(error),
  );
  speaker.setEnabled(true);
  speaker.enqueue("one", AGENT);
  speaker.enqueue("two", AGENT);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(errors.length, 1);
  assert.deepEqual(spoken, ["two"]);
});

test("watchdogMs sizes the safety timer from the text, hardcoded", () => {
  // Some browsers fire neither onend nor onerror (cancel() and synthesis
  // failure paths); the watchdog force-settles the utterance after this
  // long, so `speaking` cannot stick true and hold finals forever.
  assert.equal(WATCHDOG_MS_PER_CHAR, 90);
  assert.equal(WATCHDOG_SLACK_MS, 5_000);
  assert.equal(watchdogMs(""), 5_000);
  assert.equal(watchdogMs("abc"), 5_270);
  assert.equal(watchdogMs("x".repeat(100)), 14_000);
  assert.equal(watchdogMs("y".repeat(1000)), 95_000);
});

// --- deterministic per-agent voice selection ---

const voice = (name, { lang = "en-US", localService = true } = {}) => ({
  name,
  lang,
  localService,
  voiceURI: `uri:${name}`,
});

test("fnv1a matches the published FNV-1a 32-bit test vectors", () => {
  // 0x811c9dc5 is the offset basis; 0xe40c292c is the canonical hash of
  // "a". A "hash" that misses these is not FNV-1a and the profile pins
  // below change meaning.
  assert.equal(fnv1a(""), 2166136261);
  assert.equal(fnv1a("a"), 3826002220);
});

test("rankVoices puts local English voices first, then stable name order", () => {
  const ranked = rankVoices([
    voice("Zeta", { localService: false }),
    voice("Beta", { localService: true }),
    voice("Delta", { lang: "de-DE", localService: true }),
    voice("Alpha", { localService: true }),
    voice("Gamma", { localService: false }),
  ]);
  // Classes: local+en (Alpha, Beta) → local+non-en (Delta) → network+en
  // (Gamma, Zeta). Within a class, alphabetical by name.
  assert.deepEqual(
    ranked.map((entry) => entry.name),
    ["Alpha", "Beta", "Delta", "Gamma", "Zeta"],
  );
});

test("rankVoices does not mutate its input", () => {
  const input = [
    voice("B", { localService: false }),
    voice("A", { localService: true }),
  ];
  rankVoices(input);
  assert.equal(input[0].name, "B");
});

test("profiles are pinned: the same pubkey is the same voice, hardcoded", () => {
  // Measured outputs of the pure function, pinned so any drift in ranking
  // or hashing that would silently reassign every agent's voice is caught.
  const ranked = rankVoices([
    voice("Samantha"),
    voice("Ava"),
    voice("Daniel"),
    voice("Google UK English Female", { localService: false }),
    voice("Google US English", { localService: false }),
  ]);
  assert.deepEqual(speechVoiceProfile(AGENT, ranked), {
    voiceIndex: 1,
    rate: 1,
    pitch: 1,
    voiceURI: "uri:Daniel",
  });
  assert.deepEqual(speechVoiceProfile(OTHER_AGENT, ranked), {
    voiceIndex: 0,
    rate: 1,
    pitch: 1,
    voiceURI: "uri:Ava",
  });
});

test("profile derivation is case-insensitive on the pubkey", () => {
  const ranked = rankVoices([voice("A"), voice("B"), voice("C")]);
  assert.deepEqual(
    speechVoiceProfile(AGENT.toUpperCase(), ranked),
    speechVoiceProfile(AGENT, ranked),
  );
});

test("ten agents spread across at least four of five ranked voices", () => {
  const ranked = rankVoices([
    voice("V0"),
    voice("V1"),
    voice("V2"),
    voice("V3"),
    voice("V4"),
  ]);
  const picked = new Set(
    Array.from({ length: 10 }, (_, i) =>
      speechVoiceProfile(String.fromCharCode(97 + i).repeat(64), ranked),
    ).map((profile) => profile.voiceIndex),
  );
  // A broken hash (constant, or colliding on one bucket) lands everything
  // on one voice; a real spread over 10 keys reaches most of the list.
  assert.ok(picked.size >= 4, `spread too thin: ${[...picked].join(",")}`);
});

test("a rich voice list keeps every agent at natural pitch", () => {
  const ranked = rankVoices([voice("A"), voice("B"), voice("C")]);
  assert.equal(ranked.length >= VOICE_PITCH_SPREAD_BELOW, true);
  assert.equal(speechVoiceProfile(AGENT, ranked).pitch, 1);
});

test("a scarce voice list differentiates agents by stable pitch", () => {
  const ranked = rankVoices([voice("Only")]);
  const first = speechVoiceProfile(AGENT, ranked);
  const second = speechVoiceProfile(OTHER_AGENT, ranked);
  // Same single voice, different pitch — pinned measured values.
  assert.equal(first.voiceURI, "uri:Only");
  assert.equal(first.pitch, 0.89);
  assert.equal(second.pitch, 1.04);
  for (const profile of [first, second]) {
    assert.ok(profile.pitch >= 0.85 && profile.pitch <= 1.15);
  }
});

test("an empty voice list degrades to engine defaults, not a crash", () => {
  assert.deepEqual(speechVoiceProfile(AGENT, []), {
    voiceIndex: 0,
    rate: 1,
    pitch: 1,
    voiceURI: null,
  });
});

// --- English-pool selection ---
//
// Huddle speech is English text; a non-English voice reads it
// unintelligibly. These tests exist because a green e2e once logged a
// Cantonese voice (Sinji, yue-HK) as "a named deterministic voice" —
// named was asserted, English never was (2026-09-16).

const agentNo = (i) =>
  (i.toString(16).padStart(2, "0") + "0".repeat(64)).slice(0, 64);

test("every agent lands on an English voice when the ranked list is mixed", () => {
  const ranked = rankVoices([
    voice("Samantha"),
    voice("Ava"),
    voice("Daniel"),
    voice("Tina", { lang: "sl-SI" }),
    voice("Rocko", { lang: "es-MX" }),
    voice("Grandma", { lang: "fr-CA" }),
    voice("Google US English", { localService: false }),
    voice("Reed", { lang: "ko-KR", localService: false }),
  ]);
  for (let i = 0; i < 200; i++) {
    const profile = speechVoiceProfile(agentNo(i), ranked);
    const chosen = resolveProfileVoice(profile, ranked);
    assert.ok(chosen, `agent ${i}: ${profile.voiceURI} not in list`);
    assert.ok(
      chosen.lang.toLowerCase().startsWith("en"),
      `agent ${i} landed on ${chosen.name} (${chosen.lang})`,
    );
  }
});

test("a local non-English voice outranking remote English ones is never picked", () => {
  // rankVoices tiers local non-English (1) ahead of remote English (2),
  // so the ranked list interleaves: Tina first, English after. A
  // head-slice "English block" of the first englishCount entries
  // CONTAINS Tina — this test is the filter-vs-slice discriminator.
  const ranked = rankVoices([
    voice("Tina", { lang: "sl-SI" }),
    voice("GEn1", { localService: false }),
    voice("GEn2", { localService: false }),
    voice("GEn3", { localService: false }),
  ]);
  assert.deepEqual(
    ranked.map((entry) => entry.name),
    ["Tina", "GEn1", "GEn2", "GEn3"],
  );
  for (let i = 0; i < 200; i++) {
    const profile = speechVoiceProfile(agentNo(i), ranked);
    assert.notEqual(profile.voiceURI, "uri:Tina");
    assert.match(profile.voiceURI ?? "", /^uri:GEn/);
  }
});

test("a system with no English voices degrades to the engine default", () => {
  const ranked = rankVoices([
    voice("Tina", { lang: "sl-SI" }),
    voice("Rocko", { lang: "es-MX" }),
  ]);
  assert.deepEqual(speechVoiceProfile(AGENT, ranked), {
    voiceIndex: 0,
    rate: 1,
    pitch: 1,
    voiceURI: null,
  });
});

test("determinism holds inside the English pool", () => {
  const ranked = rankVoices([
    voice("Ava"),
    voice("Daniel"),
    voice("Tina", { lang: "sl-SI" }),
    voice("Google US English", { localService: false }),
  ]);
  const first = speechVoiceProfile(AGENT, ranked);
  const second = speechVoiceProfile(AGENT, ranked);
  assert.deepEqual(first, second);
  assert.deepEqual(first, speechVoiceProfile(AGENT.toUpperCase(), ranked));
});

test("a vanished voiceURI resolves to no voice, never an index fallback", () => {
  const ranked = rankVoices([voice("A"), voice("B"), voice("C")]);
  const profile = speechVoiceProfile(AGENT, ranked);
  const shrunk = [voice("X"), voice("Y"), voice("Z")];
  assert.equal(resolveProfileVoice(profile, shrunk), undefined);
  assert.equal(resolveProfileVoice(profile, []), undefined);
  assert.equal(
    resolveProfileVoice(profile, ranked)?.voiceURI,
    profile.voiceURI,
  );
});

test("a rich list with a scarce English pool still differentiates by pitch", () => {
  const voices = [voice("En1"), voice("En2")];
  for (let i = 0; i < 100; i++) {
    voices.push(voice(`Nl${i}`, { lang: "sl-SI" }));
  }
  const ranked = rankVoices(voices);
  assert.equal(ranked.length, 102);
  const first = speechVoiceProfile(AGENT, ranked);
  const second = speechVoiceProfile(OTHER_AGENT, ranked);
  // Both landed on English voices, and the two-voice pool spread their
  // pitch rather than leaving them indistinguishable.
  assert.match(first.voiceURI ?? "", /^uri:En/);
  assert.match(second.voiceURI ?? "", /^uri:En/);
  assert.ok(first.pitch >= 0.85 && first.pitch <= 1.15);
  assert.ok(second.pitch >= 0.85 && second.pitch <= 1.15);
  assert.notEqual(first.pitch, second.pitch);
});

// --- utterance chunking ---

test("empty text chunks to nothing", () => {
  assert.deepEqual(chunkSpeakableText("   \n "), []);
});

test("a short reply is one chunk", () => {
  assert.deepEqual(chunkSpeakableText("Ready when you are."), [
    "Ready when you are.",
  ]);
});

test("short sentences pack together under the cap", () => {
  const text = "One sentence here. And another one follows it up.";
  assert.deepEqual(chunkSpeakableText(text), [text]);
});

test("long sentence runs split at word boundaries, every chunk under the cap", () => {
  const chunks = chunkSpeakableText("word ".repeat(60).trim());
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= CHUNK_MAX_CHARS));
  // No words lost or reordered: the joined chunks are the original words.
  const original = "word ".repeat(60).trim().split(" ");
  const rejoined = chunks.join(" ").split(" ");
  assert.deepEqual(rejoined, original);
});

test("a single unpunctuated monster word hard-splits under the cap", () => {
  const chunks = chunkSpeakableText("x".repeat(450));
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [200, 200, 50],
  );
});

test("sentence boundaries are respected when packing", () => {
  const sentence = "A reasonably long sentence with some words in it. ";
  const chunks = chunkSpeakableText(sentence.repeat(6).trim());
  // Two packed chunks, both under the cap, no sentence torn in half at a
  // non-boundary while a boundary would have fit.
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= CHUNK_MAX_CHARS));
  assert.ok(chunks.every((chunk) => chunk.endsWith(".")));
});

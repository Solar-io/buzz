import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearHuddleVoiceState,
  loadHuddleVoiceState,
  saveHuddleVoiceState,
  voiceRestoreAnnouncement,
  VOICE_RESTORE_FAILED,
} from "./huddleVoicePersistence.ts";

/** A Map-backed stand-in for sessionStorage. */
function fakeStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

const CHANNEL = "11111111-2222-3333-4444-555555555555";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/*
 * VOICE_E2E_2026-09-17 V2: armed voice state (Listening, read-agent-replies)
 * died with the page and came back with no signal. sessionStorage is the
 * chosen scope — reloads survive, tab close does not — and restore is never
 * silent. Dropping the persistence, the toast wording, or the failure leg
 * fails the matching test below.
 */

test("armed state round-trips per huddle", () => {
  const store = fakeStore();
  saveHuddleVoiceState(store, CHANNEL, {
    voiceMode: true,
    readAgentReplies: true,
  });
  assert.deepEqual(loadHuddleVoiceState(store, CHANNEL), {
    voiceMode: true,
    readAgentReplies: true,
  });
});

test("huddles do not read each other's armed state", () => {
  const store = fakeStore();
  saveHuddleVoiceState(store, CHANNEL, {
    voiceMode: true,
    readAgentReplies: false,
  });
  assert.equal(loadHuddleVoiceState(store, OTHER), null);
});

test("clear forgets the entry (a deliberate disarm does not survive)", () => {
  const store = fakeStore();
  saveHuddleVoiceState(store, CHANNEL, {
    voiceMode: true,
    readAgentReplies: true,
  });
  clearHuddleVoiceState(store, CHANNEL);
  assert.equal(loadHuddleVoiceState(store, CHANNEL), null);
});

test("a malformed entry reads as nothing saved, never a crash", () => {
  const store = fakeStore();
  store.setItem(`buzz-huddle-voice:${CHANNEL}`, "{not json");
  assert.equal(loadHuddleVoiceState(store, CHANNEL), null);
});

test("an entry with the wrong shape reads as nothing saved", () => {
  const store = fakeStore();
  store.setItem(
    `buzz-huddle-voice:${CHANNEL}`,
    JSON.stringify({ voiceMode: "yes", readAgentReplies: 1 }),
  );
  assert.equal(loadHuddleVoiceState(store, CHANNEL), null);
  store.setItem(`buzz-huddle-voice:${CHANNEL}`, JSON.stringify([true, true]));
  assert.equal(loadHuddleVoiceState(store, CHANNEL), null);
});

test("a broken store never breaks the caller", () => {
  const throwing = {
    getItem: () => {
      throw new Error("quota");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("quota");
    },
  };
  saveHuddleVoiceState(throwing, CHANNEL, {
    voiceMode: true,
    readAgentReplies: true,
  });
  assert.equal(loadHuddleVoiceState(throwing, CHANNEL), null);
  clearHuddleVoiceState(throwing, CHANNEL);
});

test("restore announces voice mode, by name, with the reading state", () => {
  const on = voiceRestoreAnnouncement({
    voiceMode: true,
    readAgentReplies: true,
  });
  assert.equal(on.title, "Voice mode restored — Listening");
  assert.ok(on.description.includes("Reading agent replies is on"));
  const off = voiceRestoreAnnouncement({
    voiceMode: true,
    readAgentReplies: false,
  });
  assert.equal(off.title, "Voice mode restored — Listening");
  assert.ok(off.description.includes("Reading agent replies is off"));
});

test("a speech-only armed state announces itself, without claiming voice mode", () => {
  const announcement = voiceRestoreAnnouncement({
    voiceMode: false,
    readAgentReplies: true,
  });
  assert.equal(announcement.title, "Reading agent replies restored");
});

test("an entry that arms nothing announces nothing", () => {
  assert.equal(
    voiceRestoreAnnouncement({ voiceMode: false, readAgentReplies: false }),
    null,
  );
});

test("the failed-restore message names the huddle's end, hardcoded", () => {
  // Dropping this leg (or wording it as a success) restores the silent
  // failure: a saved state that can never be applied, with no signal.
  assert.equal(
    VOICE_RESTORE_FAILED.title,
    "Saved voice settings could not be restored",
  );
  assert.equal(VOICE_RESTORE_FAILED.description, "This huddle has ended.");
});

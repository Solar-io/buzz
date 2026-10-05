import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SLOT_SOUNDS,
  isSoundName,
  playNotificationSound,
  SOUND_NAMES,
  soundSlotFor,
  soundUrl,
} from "./sound.ts";

test("a DM picks the dm slot, even though it p-tags you", () => {
  assert.equal(soundSlotFor({ isDm: true, mentionsSelf: true }), "dm");
  assert.equal(soundSlotFor({ isDm: true, mentionsSelf: false }), "dm");
});

test("a channel @mention picks the mention slot", () => {
  assert.equal(soundSlotFor({ isDm: false, mentionsSelf: true }), "mention");
});

test("anything else picks the channel slot", () => {
  assert.equal(soundSlotFor({ isDm: false, mentionsSelf: false }), "channel");
});

test("shipped slot defaults", () => {
  assert.deepEqual(DEFAULT_SLOT_SOUNDS, {
    dm: "unison",
    mention: "ping",
    channel: "doop",
    reminder: "doodone",
  });
});

test("the same twelve sounds as desktop", () => {
  assert.equal(SOUND_NAMES.length, 12);
  assert.ok(isSoundName("flutter"));
  assert.ok(!isSoundName("airhorn"));
  assert.ok(!isSoundName(3));
});

test("sounds are served from /assets/ (the relay serves nothing else as files)", () => {
  assert.equal(soundUrl("ping"), "/assets/sounds/ping.mp3");
});

test("play() rewinds, plays, and swallows an autoplay rejection", async () => {
  const created = [];
  const original = globalThis.Audio;
  globalThis.Audio = class {
    constructor(src) {
      this.src = src;
      this.currentTime = 5;
      this.plays = 0;
      created.push(this);
    }
    play() {
      this.plays += 1;
      return Promise.reject(new Error("NotAllowedError"));
    }
  };
  try {
    const audio = playNotificationSound("bong");
    assert.equal(audio.src, "/assets/sounds/bong.mp3");
    assert.equal(audio.currentTime, 0);
    assert.equal(audio.plays, 1);
    // Cached: a second play reuses the element.
    assert.equal(playNotificationSound("bong"), audio);
    assert.equal(created.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.Audio = original;
  }
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { loadVideoChatConfig, saveVideoChatConfig } from "./config.ts";

// loadVideoChatConfig/saveVideoChatConfig only ever touch
// window.localStorage; a three-method stub is the entire browser surface
// they need (same stub-the-global approach as useBargeDuck.test.mjs).
const STORAGE_KEY = "buzz.videoChat.config.v1";
const store = new Map();
const fakeStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

let originalWindow;

before(() => {
  originalWindow = globalThis.window;
  globalThis.window = { localStorage: fakeStorage };
});

after(() => {
  globalThis.window = originalWindow;
  store.clear();
});

test("a stored config without autoDuck loads with autoDuck true", () => {
  // A pre-toggle install persisted exactly these keys — no autoDuck.
  const legacy = {
    anamApiKey: "k-123",
    personaName: "Evie",
    personaId: "p-1",
    avatarId: "",
    avatarModel: "",
    voiceId: "v-1",
    llmId: "l-1",
  };
  store.set(STORAGE_KEY, JSON.stringify(legacy));

  const config = loadVideoChatConfig();
  assert.equal(config.anamApiKey, "k-123", "stored fields survive the merge");
  // Literal, not derived from the EMPTY default: if the default flips this
  // assertion must fail.
  assert.equal(config.autoDuck, true);
});

test("a stored config with autoDuck false loads as false", () => {
  const stored = {
    anamApiKey: "",
    personaName: "Evie",
    personaId: "",
    avatarId: "a-1",
    avatarModel: "",
    voiceId: "",
    llmId: "",
    autoDuck: false,
  };
  store.set(STORAGE_KEY, JSON.stringify(stored));

  assert.equal(loadVideoChatConfig().autoDuck, false);

  // And the off state round-trips through save: toggling off in settings
  // must not silently re-enable on the next load.
  saveVideoChatConfig({ ...stored, personaId: "p-2" });
  assert.equal(loadVideoChatConfig().autoDuck, false);
  assert.equal(loadVideoChatConfig().personaId, "p-2");
});

test("empty storage loads the shipped defaults, autoDuck on", () => {
  store.clear();

  const config = loadVideoChatConfig();
  assert.equal(Object.keys(config).length, 8, "every config key is present");
  // Literal again — this is the unchanged-behaviour guarantee for installs
  // that never touch the new toggle.
  assert.equal(config.autoDuck, true);
  assert.equal(config.anamApiKey, "");
  assert.equal(config.personaName, "Evie");
});

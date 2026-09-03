import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  clearDraft,
  loadDraft,
  loadDraftState,
  saveDraft,
  saveDraftState,
} from "./drafts.ts";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

const descriptor = (url) => ({
  url,
  sha256: "c".repeat(64),
  mime_type: "image/png",
  size: 4096,
});

test("a draft carries attachments and mention picks, not just text", () => {
  saveDraftState("ch1", {
    text: "look at @Sam",
    media: [descriptor("https://r/1.png")],
    filenames: { "https://r/1.png": "shot.png" },
    mentionPicks: { sam: "pubkey-sam" },
  });
  const restored = loadDraftState("ch1");
  assert.equal(restored.text, "look at @Sam");
  assert.equal(restored.media.length, 1);
  assert.equal(restored.media[0].url, "https://r/1.png");
  assert.equal(restored.filenames["https://r/1.png"], "shot.png");
  assert.equal(restored.mentionPicks.sam, "pubkey-sam");
});

test("saving text MERGES — it must not drop the attachments", () => {
  saveDraftState("ch1", {
    text: "one",
    media: [descriptor("https://r/1.png")],
    filenames: {},
    mentionPicks: { sam: "pubkey-sam" },
  });
  // This is the typing path: one call per keystroke, text only.
  saveDraft("ch1", "one two");
  const restored = loadDraftState("ch1");
  assert.equal(restored.text, "one two");
  assert.equal(
    restored.media.length,
    1,
    "the uploaded attachment survives a text-only save",
  );
  assert.equal(restored.mentionPicks.sam, "pubkey-sam");
});

test("drafts written by an older build (a bare string) still load", () => {
  globalThis.localStorage.setItem(
    "buzz.drafts.v1",
    JSON.stringify({ ch1: "legacy text" }),
  );
  assert.equal(loadDraft("ch1"), "legacy text");
  const state = loadDraftState("ch1");
  assert.equal(state.text, "legacy text");
  assert.deepEqual(state.media, []);
  assert.deepEqual(state.mentionPicks, {});
});

test("an attachment-only draft is kept even with no text", () => {
  saveDraftState("ch1", {
    text: "",
    media: [descriptor("https://r/1.png")],
    filenames: {},
    mentionPicks: {},
  });
  assert.equal(loadDraftState("ch1").media.length, 1);
});

test("an entirely empty draft is removed", () => {
  saveDraftState("ch1", {
    text: "x",
    media: [],
    filenames: {},
    mentionPicks: {},
  });
  saveDraftState("ch1", {
    text: "",
    media: [],
    filenames: {},
    mentionPicks: {},
  });
  assert.equal(loadDraftState("ch1").text, "");
  assert.equal(
    globalThis.localStorage.getItem("buzz.drafts.v1"),
    null,
    "the last entry going empty clears the key",
  );
});

test("clearDraft after send drops attachments and picks with the text", () => {
  saveDraftState("ch1", {
    text: "bye",
    media: [descriptor("https://r/1.png")],
    filenames: {},
    mentionPicks: { sam: "pubkey-sam" },
  });
  clearDraft("ch1");
  const restored = loadDraftState("ch1");
  assert.equal(restored.text, "");
  assert.deepEqual(restored.media, []);
  assert.deepEqual(restored.mentionPicks, {});
});

test("channels do not share draft state", () => {
  saveDraftState("ch1", {
    text: "a",
    media: [descriptor("https://r/1.png")],
    filenames: {},
    mentionPicks: {},
  });
  saveDraftState("ch2", {
    text: "b",
    media: [],
    filenames: {},
    mentionPicks: { bob: "pubkey-bob" },
  });
  assert.equal(loadDraftState("ch1").media.length, 1);
  assert.deepEqual(loadDraftState("ch1").mentionPicks, {});
  assert.equal(loadDraftState("ch2").media.length, 0);
  assert.equal(loadDraftState("ch2").mentionPicks.bob, "pubkey-bob");
});

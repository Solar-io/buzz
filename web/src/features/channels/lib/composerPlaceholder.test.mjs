import assert from "node:assert/strict";
import { test } from "node:test";

// localSeed (which composerPlaceholder reads through) touches
// window.localStorage at CALL time, so a stub installed before the dynamic
// import is enough.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};

const { channelLabelFromSeed, channelMention, composerPlaceholder } =
  await import("./composerPlaceholder.ts");

function seedChannels(entries) {
  store.set("channels:v1", JSON.stringify(entries));
}

test("the channel composer names the channel", () => {
  assert.equal(
    composerPlaceholder({ channel: { name: "general", isDm: false } }),
    "Message #general",
  );
});

test("a DM takes no hash", () => {
  assert.equal(
    composerPlaceholder({ channel: { name: "Sam Gallant", isDm: true } }),
    "Message Sam Gallant",
  );
  assert.equal(channelMention({ name: "x", isDm: true }), "x");
  assert.equal(channelMention({ name: "x", isDm: false }), "#x");
});

test("a reply names the target and the channel", () => {
  assert.equal(
    composerPlaceholder({
      channel: { name: "general", isDm: false },
      replyToAuthor: "Alice",
    }),
    "Reply to Alice in #general",
  );
});

test("a reply with no known channel still names the target", () => {
  assert.equal(
    composerPlaceholder({ replyToAuthor: "Alice" }),
    "Reply to Alice",
  );
});

test("editing wins over every other context", () => {
  assert.equal(
    composerPlaceholder({
      editing: true,
      override: "Write your post...",
      channel: { name: "general", isDm: false },
      replyToAuthor: "Alice",
    }),
    "Edit your message",
  );
});

test("an explicit override wins over the channel", () => {
  assert.equal(
    composerPlaceholder({
      override: "Write your post...",
      channel: { name: "general", isDm: false },
    }),
    "Write your post...",
  );
});

test("with no channel known at all it falls back to the keyboard hint", () => {
  assert.equal(
    composerPlaceholder({}),
    "Message — @ to mention, Shift+Enter for newline",
  );
});

test("the channel name is resolved from the seeded channel list", () => {
  seedChannels({
    "chan-1": { id: "chan-1", name: "engineering", type: "stream" },
    "dm-1": { id: "dm-1", name: "Bob", type: "dm" },
  });
  assert.deepEqual(channelLabelFromSeed("chan-1"), {
    name: "engineering",
    isDm: false,
  });
  assert.deepEqual(channelLabelFromSeed("dm-1"), { name: "Bob", isDm: true });
  assert.equal(
    composerPlaceholder({ channel: channelLabelFromSeed("chan-1") }),
    "Message #engineering",
  );
});

test("an unseeded or malformed channel resolves to null, never a broken name", () => {
  seedChannels({
    "chan-1": { id: "chan-1", name: "engineering", type: "stream" },
    "chan-2": { id: "chan-2", name: "   ", type: "stream" },
    "chan-3": "not an object",
  });
  assert.equal(channelLabelFromSeed("missing"), null);
  assert.equal(channelLabelFromSeed("chan-2"), null, "a blank name is no name");
  assert.equal(channelLabelFromSeed("chan-3"), null);
  assert.equal(channelLabelFromSeed(null), null);
  assert.equal(channelLabelFromSeed(undefined), null);
});

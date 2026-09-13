import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_SHORTCUTS_PER_CHANNEL,
  SHORTCUT_BLOB_BUDGET_BYTES,
  addShortcut,
  blobByteLength,
  emptyShortcutBlob,
  nextShortcutId,
  parseShortcutBlob,
  removeShortcut,
  serializeShortcutBlob,
  shortcutListFor,
  updateShortcut,
} from "./shortcutBlob.ts";

const CHANNEL = "5b1f2a34-1111-4222-8333-444455556666";
const OTHER = "aaaaaaaa-1111-4222-8333-444455556666";

function _blobWith(channelId, shortcuts) {
  const blob = emptyShortcutBlob();
  if (shortcuts.length > 0) {
    blob.shortcuts[channelId] = shortcuts;
  }
  return blob;
}

function addOk(blob, channelId, input) {
  const result = addShortcut(blob, channelId, input);
  assert.equal(result.ok, true, `add should succeed: ${JSON.stringify(input)}`);
  return result.blob;
}

test("add normalizes the URL, labels, and allocates sc:1", () => {
  const blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "kept.example",
    label: " kept ",
    mode: "overlay",
  });
  assert.deepEqual(shortcutListFor(blob, CHANNEL), [
    {
      id: "sc:1",
      label: "kept",
      url: "https://kept.example/",
      mode: "overlay",
    },
  ]);
});

test("serialize/parse round-trips exactly", () => {
  let blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/x",
    label: "kept",
    mode: "overlay",
  });
  blob = addOk(blob, OTHER, { url: "http://box.lan:8080", mode: "window" });
  const parsed = parseShortcutBlob(JSON.parse(serializeShortcutBlob(blob)));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.blob, blob);
});

test("the serialized v1 shape is pinned", () => {
  const blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
    label: "kept",
    mode: "overlay",
  });
  assert.equal(
    serializeShortcutBlob(blob),
    '{"v":1,"shortcuts":{"5b1f2a34-1111-4222-8333-444455556666":[{"id":"sc:1","label":"kept","url":"https://kept.example/","mode":"overlay"}]}}',
  );
});

test("invalid URL entries are DROPPED on read, not trusted", () => {
  const parsed = parseShortcutBlob({
    v: 1,
    shortcuts: {
      [CHANNEL]: [
        {
          id: "sc:1",
          label: "evil",
          url: "javascript:alert(1)",
          mode: "overlay",
        },
        { id: "sc:2", label: "ok", url: "https://ok.example/", mode: "window" },
        {
          id: "sc:2",
          label: "dupe",
          url: "https://dupe.example/",
          mode: "window",
        },
        "not an object",
        { label: "no id", url: "https://x.example/" },
      ],
    },
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(shortcutListFor(parsed.blob, CHANNEL), [
    { id: "sc:2", label: "ok", url: "https://ok.example/", mode: "window" },
  ]);
});

test("a future version is reported, never parsed best-effort", () => {
  const result = parseShortcutBlob({ v: 2, shortcuts: {} });
  assert.deepEqual(result, { ok: false, reason: "future-version" });
});

test("malformed content is reported", () => {
  assert.deepEqual(parseShortcutBlob("nope"), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(parseShortcutBlob({ v: "1", shortcuts: {} }), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(parseShortcutBlob({ v: 1 }), {
    ok: false,
    reason: "malformed",
  });
  assert.deepEqual(parseShortcutBlob(null), { ok: false, reason: "malformed" });
});

test("a hostile URL is refused with a reason at add time", () => {
  const result = addShortcut(emptyShortcutBlob(), CHANNEL, {
    url: "javascript://evil.example/%0aalert(1)",
    label: "evil",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /http:\/\/ or https:\/\//);
});

test("the per-channel cap is enforced at add time", () => {
  let blob = emptyShortcutBlob();
  for (let index = 0; index < MAX_SHORTCUTS_PER_CHANNEL; index += 1) {
    blob = addOk(blob, CHANNEL, { url: `https://x${index}.example/` });
  }
  const overflow = addShortcut(blob, CHANNEL, {
    url: "https://one-more.example/",
  });
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, /at most 12 shortcuts/);
});

test("the cap is per channel, not per blob", () => {
  let blob = emptyShortcutBlob();
  for (let index = 0; index < MAX_SHORTCUTS_PER_CHANNEL; index += 1) {
    blob = addOk(blob, CHANNEL, { url: `https://x${index}.example/` });
  }
  assert.equal(
    addOk(blob, OTHER, { url: "https://y.example/" }).ok !== false,
    true,
  );
});

test("labels over 32 characters are refused", () => {
  const result = addShortcut(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
    label: "x".repeat(33),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /32 characters/);
});

test("exactly 32 characters is allowed", () => {
  const blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
    label: "x".repeat(32),
  });
  assert.equal(shortcutListFor(blob, CHANNEL)[0].label.length, 32);
});

test("URLs over 512 characters are refused", () => {
  const result = addShortcut(emptyShortcutBlob(), CHANNEL, {
    url: `https://kept.example/${"a".repeat(512)}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /512 characters/);
});

test("an add that would exceed the 16,384-byte budget is refused", () => {
  // A blob one add away from the budget, built by hand so the size is
  // deterministic — the guard runs on serialize, whatever produced the blob.
  const blob = {
    v: 1,
    shortcuts: {
      [CHANNEL]: Array.from({ length: 12 }, (_, index) => ({
        id: `sc:${index + 1}`,
        label: "y".repeat(1290),
        url: `https://x${index}.example/`,
        mode: "window",
      })),
    },
  };
  assert.ok(
    blobByteLength(serializeShortcutBlob(blob)) < SHORTCUT_BLOB_BUDGET_BYTES,
    `precondition: blob must start under budget, got ${blobByteLength(serializeShortcutBlob(blob))}`,
  );
  const result = addShortcut(blob, OTHER, {
    url: "https://final.example/",
    label: "final",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /16,384 bytes/);
});

test("update rewrites in place and keeps the id", () => {
  let blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
    label: "kept",
    mode: "overlay",
  });
  blob = addOk(blob, CHANNEL, { url: "https://second.example/" });
  const updated = updateShortcut(blob, CHANNEL, "sc:1", {
    url: "https://moved.example/",
    label: "moved",
    mode: "window",
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(shortcutListFor(updated.blob, CHANNEL), [
    {
      id: "sc:1",
      label: "moved",
      url: "https://moved.example/",
      mode: "window",
    },
    {
      id: "sc:2",
      label: "second.example",
      url: "https://second.example/",
      mode: "window",
    },
  ]);
});

test("update validates like add", () => {
  const blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
  });
  const result = updateShortcut(blob, CHANNEL, "sc:1", {
    url: "javascript:alert(1)",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /http:\/\/ or https:\/\//);
});

test("update on a foreign id is refused with a reason", () => {
  const result = updateShortcut(emptyShortcutBlob(), CHANNEL, "sc:9", {
    url: "https://kept.example/",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no longer exists/);
});

test("remove deletes the entry and prunes the empty channel key", () => {
  let blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
  });
  blob = addOk(blob, OTHER, { url: "https://other.example/" });
  const removed = removeShortcut(blob, CHANNEL, "sc:1");
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.blob.shortcuts, {
    [OTHER]: [
      {
        id: "sc:2",
        label: "other.example",
        url: "https://other.example/",
        mode: "window",
      },
    ],
  });
});

test("removing the last shortcut of the last channel leaves an empty blob", () => {
  const blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
  });
  const removed = removeShortcut(blob, CHANNEL, "sc:1");
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.blob, { v: 1, shortcuts: {} });
  assert.equal(serializeShortcutBlob(removed.blob), '{"v":1,"shortcuts":{}}');
});

test("remove of an unknown id is a no-op success", () => {
  const blob = addOk(emptyShortcutBlob(), CHANNEL, {
    url: "https://kept.example/",
  });
  const removed = removeShortcut(blob, CHANNEL, "sc:42");
  assert.equal(removed.ok, true);
  assert.equal(shortcutListFor(removed.blob, CHANNEL).length, 1);
});

test("ids are allocated across the WHOLE blob and never reused", () => {
  let blob = addOk(emptyShortcutBlob(), CHANNEL, { url: "https://a.example/" });
  blob = addOk(blob, OTHER, { url: "https://b.example/" });
  blob = removeShortcut(blob, CHANNEL, "sc:1").ok
    ? removeShortcut(blob, CHANNEL, "sc:1").blob
    : blob;
  assert.equal(nextShortcutId(blob), "sc:3");
  const grown = addOk(blob, CHANNEL, { url: "https://c.example/" });
  assert.equal(shortcutListFor(grown, CHANNEL)[0].id, "sc:3");
});

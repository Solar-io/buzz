import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_SHORTCUTS_PER_LIST,
  SHORTCUT_BLOB_BUDGET_BYTES,
  SHORTCUT_SIDEBAR_KEY,
  addShortcut,
  addSidebarShortcut,
  blobByteLength,
  emptyShortcutBlob,
  nextShortcutId,
  parseShortcutBlob,
  removeShortcut,
  removeSidebarShortcut,
  serializeShortcutBlob,
  shortcutListFor,
  sidebarShortcuts,
  updateShortcut,
  updateSidebarShortcut,
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
  for (let index = 0; index < MAX_SHORTCUTS_PER_LIST; index += 1) {
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
  for (let index = 0; index < MAX_SHORTCUTS_PER_LIST; index += 1) {
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

/*
 * The sidebar list — the channel-independent one under SHORTCUT_SIDEBAR_KEY.
 */

/** Build a blob holding these per-channel lists, keyed in the given order. */
function channelBlob(entries) {
  const blob = emptyShortcutBlob();
  for (const [channelId, list] of entries) {
    blob.shortcuts[channelId] = list;
  }
  return blob;
}

function def(id, url, mode = "window", label = "L") {
  return { id, label, url, mode };
}

test("addSidebarShortcut writes the reserved key, not a channel", () => {
  const result = addSidebarShortcut(emptyShortcutBlob(), {
    url: "https://kept.example/",
    label: "kept",
    mode: "overlay",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blob.shortcuts, {
    [SHORTCUT_SIDEBAR_KEY]: [
      {
        id: "sc:1",
        label: "kept",
        url: "https://kept.example/",
        mode: "overlay",
      },
    ],
  });
  assert.equal(SHORTCUT_SIDEBAR_KEY, "__sidebar__");
});

test("sidebar reducers leave every per-channel list untouched", () => {
  const channelList = [def("sc:9", "https://channel.example/")];
  let blob = channelBlob([[CHANNEL, channelList]]);
  // Ids are blob-wide, so the first sidebar entry is sc:10 — the channel's
  // sc:9 is taken. That it skips it is itself evidence the allocator sees the
  // whole blob.
  const added = addSidebarShortcut(blob, { url: "https://side.example/" });
  assert.equal(added.ok, true);
  assert.equal(added.blob.shortcuts[SHORTCUT_SIDEBAR_KEY][1].id, "sc:10");
  blob = added.blob;
  blob = updateSidebarShortcut(blob, "sc:10", {
    url: "https://moved.example/",
  }).blob;
  blob = removeSidebarShortcut(blob, "sc:10").blob;
  // The channel's list is byte-identical through all three sidebar edits —
  // that is the rollback path, and nothing here may touch it.
  assert.deepEqual(blob.shortcuts[CHANNEL], channelList);
  // The sidebar list is the SEED (the channel's own entry, adopted on first
  // write) minus the one that was added and removed.
  assert.deepEqual(blob.shortcuts[SHORTCUT_SIDEBAR_KEY], channelList);
});

test("update rewrites a sidebar entry in place and keeps its id", () => {
  let blob = addSidebarShortcut(emptyShortcutBlob(), {
    url: "https://kept.example/",
    label: "kept",
    mode: "overlay",
  }).blob;
  blob = addSidebarShortcut(blob, { url: "https://second.example/" }).blob;
  const updated = updateSidebarShortcut(blob, "sc:1", {
    url: "https://moved.example/",
    label: "moved",
    mode: "window",
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(sidebarShortcuts(updated.blob), [
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

test("update validates like add and refuses a foreign id", () => {
  const blob = addSidebarShortcut(emptyShortcutBlob(), {
    url: "https://kept.example/",
  }).blob;
  const hostile = updateSidebarShortcut(blob, "sc:1", {
    url: "javascript:alert(1)",
  });
  assert.equal(hostile.ok, false);
  assert.match(hostile.reason, /http:\/\/ or https:\/\//);
  const foreign = updateSidebarShortcut(blob, "sc:9", {
    url: "https://kept.example/",
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /no longer exists/);
});

test("the sidebar cap is enforced and named neutrally", () => {
  let blob = emptyShortcutBlob();
  for (let index = 0; index < MAX_SHORTCUTS_PER_LIST; index += 1) {
    blob = addSidebarShortcut(blob, { url: `https://x${index}.example/` }).blob;
  }
  const overflow = addSidebarShortcut(blob, {
    url: "https://one-more.example/",
  });
  assert.equal(overflow.ok, false);
  assert.match(overflow.reason, /at most 12 shortcuts/);
});

test("a sidebar add that would exceed the byte budget is refused", () => {
  // Eleven big entries in the SIDEBAR list — under the 12 cap, so the refusal
  // can only come from the byte budget, and one small add tips it over.
  const blob = {
    v: 1,
    shortcuts: {
      [SHORTCUT_SIDEBAR_KEY]: Array.from({ length: 11 }, (_, index) => ({
        id: `sc:${index + 1}`,
        label: "y".repeat(1410),
        url: `https://x${index}.example/`,
        mode: "window",
      })),
    },
  };
  const before = blobByteLength(serializeShortcutBlob(blob));
  assert.ok(
    before < SHORTCUT_BLOB_BUDGET_BYTES,
    `precondition: blob must start under budget, was ${before}`,
  );
  // Under the cap, so this is not the cap refusing it.
  assert.ok(sidebarShortcuts(blob).length < MAX_SHORTCUTS_PER_LIST);
  const result = addSidebarShortcut(blob, {
    url: "https://final.example/",
    label: "final",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /16,384 bytes/);
});

test("an ABSENT sidebar key seeds the ordered union, deduped by (url, mode)", () => {
  const blob = channelBlob([
    [CHANNEL, [def("sc:1", "https://a.example/", "window")]],
    [OTHER, [def("sc:5", "https://a.example/", "window")]],
  ]);
  // Same url AND mode in two channels collapses to ONE row, first one wins...
  assert.deepEqual(sidebarShortcuts(blob), [
    def("sc:1", "https://a.example/", "window"),
  ]);

  // ...but the same url in the OTHER mode is a genuinely different row, so
  // both survive, in channel-then-list order.
  const both = channelBlob([
    [CHANNEL, [def("sc:1", "https://a.example/", "window")]],
    [OTHER, [def("sc:5", "https://a.example/", "overlay")]],
  ]);
  assert.deepEqual(sidebarShortcuts(both), [
    def("sc:1", "https://a.example/", "window"),
    def("sc:5", "https://a.example/", "overlay"),
  ]);
});

test("the seed follows Object.keys insertion order, not id order", () => {
  const blob = channelBlob([
    [OTHER, [def("sc:9", "https://second.example/")]],
    [CHANNEL, [def("sc:2", "https://first.example/")]],
  ]);
  assert.deepEqual(
    sidebarShortcuts(blob).map((shortcut) => shortcut.url),
    ["https://second.example/", "https://first.example/"],
  );
});

test("an empty seed is an empty list, not a crash", () => {
  assert.deepEqual(sidebarShortcuts(emptyShortcutBlob()), []);
});

test("a PRESENT but empty sidebar list is authoritative — removals stick", () => {
  // The blob still carries channel shortcuts, so a UNION here would
  // resurrect them. This is the whole reason assembleSidebar exists.
  const blob = channelBlob([
    [CHANNEL, [def("sc:1", "https://a.example/", "window")]],
    [OTHER, [def("sc:2", "https://b.example/", "overlay")]],
  ]);
  assert.equal(
    sidebarShortcuts(blob).length,
    2,
    "precondition: seed is 2 rows",
  );

  const seeded = sidebarShortcuts(blob);
  let emptied = blob;
  for (const shortcut of seeded) {
    const result = removeSidebarShortcut(emptied, shortcut.id);
    assert.equal(result.ok, true);
    emptied = result.blob;
  }

  // Written as [], NEVER deleted — that is what stops the union returning.
  assert.deepEqual(emptied.shortcuts[SHORTCUT_SIDEBAR_KEY], []);
  assert.equal(SHORTCUT_SIDEBAR_KEY in emptied.shortcuts, true);
  assert.deepEqual(sidebarShortcuts(emptied), []);
  // And it survives the wire, which is where a prune would have done damage.
  const reparsed = parseShortcutBlob(
    JSON.parse(serializeShortcutBlob(emptied)),
  );
  assert.equal(reparsed.ok, true);
  assert.deepEqual(reparsed.blob.shortcuts[SHORTCUT_SIDEBAR_KEY], []);
  assert.deepEqual(sidebarShortcuts(reparsed.blob), []);
});

test("the sidebar's first write adopts the seed it was showing", () => {
  // Absent key, two channels, one duplicated url+mode.
  const blob = channelBlob([
    [CHANNEL, [def("sc:1", "https://a.example/", "window")]],
    [
      OTHER,
      [
        def("sc:2", "https://a.example/", "window"),
        def("sc:3", "https://b.example/", "overlay"),
      ],
    ],
  ]);
  const result = addSidebarShortcut(blob, { url: "https://c.example/" });
  assert.equal(result.ok, true);
  // The stored list is the seed (deduped) plus the new entry.
  assert.deepEqual(
    sidebarShortcuts(result.blob).map((shortcut) => shortcut.url),
    ["https://a.example/", "https://b.example/", "https://c.example/"],
  );
});

test("per-channel keys are never migrated away", () => {
  const seeded = addSidebarShortcut(
    channelBlob([[CHANNEL, [def("sc:1", "https://a.example/")]]]),
    { url: "https://b.example/" },
  ).blob;
  // Both the new sidebar key AND the original channel key are present: the
  // channel copy is the rollback path to the previous build.
  assert.equal(SHORTCUT_SIDEBAR_KEY in seeded.shortcuts, true);
  assert.equal(CHANNEL in seeded.shortcuts, true);
  assert.equal(seeded.shortcuts[CHANNEL].length, 1);
});

test("sidebar ids come from the whole blob, like every other list", () => {
  // The channel list already holds sc:7. The first sidebar add must therefore
  // take sc:8 — colliding with the channel's id would mean two rows sharing
  // an id across surfaces, and the allocator would stop being blob-wide.
  const blob = channelBlob([[CHANNEL, [def("sc:7", "https://a.example/")]]]);
  const result = addSidebarShortcut(blob, { url: "https://b.example/" });
  assert.equal(result.ok, true);
  const list = sidebarShortcuts(result.blob);
  // Index 0 is the seeded channel entry; the new one is appended after it.
  assert.deepEqual(
    list.map((shortcut) => shortcut.id),
    ["sc:7", "sc:8"],
  );
  assert.equal(list[1].url, "https://b.example/");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelEdit,
  changeDraft,
  editedSinceShared,
  gone,
  isDirty,
  loaded,
  polled,
  reasonText,
  saveConflicted,
  saveStarted,
  saveSucceeded,
  startEdit,
  takeTheirs,
} from "./diskDocument.ts";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const doc = (content, digest, mtimeMs, lossy = false) => ({
  content,
  digest,
  mtimeMs,
  size: content.length,
  lossy,
});

test("load → live; a lossy decode is read-only", () => {
  const live = loaded(doc("# A\n", D1, 10));
  assert.equal(live.phase, "live");
  assert.deepEqual(live.live, { content: "# A\n", digest: D1, mtimeMs: 10 });
  const lossy = loaded(doc("x", D1, 10, true));
  assert.equal(lossy.phase, "readonly");
  assert.equal(lossy.reason, "lossy");
});

test("poll 200 while clean replaces the content silently", () => {
  const next = polled(loaded(doc("old", D1, 10)), doc("agent edit", D2, 20));
  assert.equal(next.live.content, "agent edit");
  assert.equal(next.changedOnDisk, null);
  // …and an open but clean editor follows it too.
  const editing = polled(
    startEdit(loaded(doc("old", D1, 10))),
    doc("new", D2, 20),
  );
  assert.equal(editing.editing.draft, "new");
  assert.equal(editing.editing.base.digest, D2);
});

test("poll 200 while dirty raises banner, keeps draft", () => {
  let s = startEdit(loaded(doc("old", D1, 10)));
  s = changeDraft(s, "sam's draft");
  assert.equal(isDirty(s), true);
  const next = polled(s, doc("agent edit", D2, 20));
  assert.equal(next.editing.draft, "sam's draft");
  assert.equal(next.editing.base.digest, D1);
  assert.deepEqual(next.changedOnDisk, {
    content: "agent edit",
    digest: D2,
    mtimeMs: 20,
  });
  // Cancel leaves the editor on the newest disk version.
  assert.equal(cancelEdit(next).live.content, "agent edit");
});

test("each refusal has its reason", () => {
  const table = [
    [
      "no-path",
      "Shared as a snapshot with no path on crichton, so it can't be edited here. Ask the agent below.",
    ],
    [
      "other-host",
      "This file lives on another computer than the one Files opens, so it can't be edited here.",
    ],
    ["signed-out", "Sign in to Files to edit"],
    ["unreachable", "Files isn't reachable"],
    ["outside-roots", "Outside the folders Files can open"],
    ["not-editable", "This file type isn't editable"],
    ["too-large", "Too large to edit here (over 2 MiB)"],
    ["lossy", "This file has bytes the editor can't round-trip"],
    ["gone", "This file was moved or deleted on crichton"],
  ];
  assert.equal(table.length, 9);
  for (const [reason, text] of table) {
    assert.equal(reasonText(reason), text, reason);
  }
  assert.equal(new Set(table.map(([reason]) => reasonText(reason))).size, 9);
});

test("edited-since-shared", () => {
  assert.equal(editedSinceShared(D1, D2), true);
  assert.equal(editedSinceShared(D1, D1), false);
  assert.equal(editedSinceShared(D1, D1.toUpperCase()), false);
  assert.equal(editedSinceShared(D1, null), false);
  assert.equal(editedSinceShared(null, D1), false);
});

test("save: success rebases the draft; a conflict keeps it", () => {
  let s = changeDraft(startEdit(loaded(doc("old", D1, 10))), "mine");
  s = saveStarted(s);
  assert.equal(s.saving, true);
  const ok = saveSucceeded(s, "mine", D2, 30);
  assert.equal(ok.saved, true);
  assert.equal(isDirty(ok), false);
  assert.deepEqual(ok.live, { content: "mine", digest: D2, mtimeMs: 30 });
  const conflict = saveConflicted(s, D2, 30);
  assert.equal(conflict.editing.draft, "mine");
  assert.deepEqual(conflict.conflict, { digest: D2, mtimeMs: 30 });
  const theirs = takeTheirs(conflict, doc("theirs", D2, 30));
  assert.equal(theirs.editing.draft, "theirs");
  assert.equal(theirs.conflict, null);
});

test("a vanished file keeps a dirty draft so it can be copied", () => {
  const s = changeDraft(startEdit(loaded(doc("old", D1, 10))), "unsaved");
  const g = gone(s);
  assert.equal(g.phase, "readonly");
  assert.equal(g.reason, "gone");
  assert.equal(g.orphanDraft, "unsaved");
  assert.equal(gone(loaded(doc("old", D1, 10))).orphanDraft, null);
});

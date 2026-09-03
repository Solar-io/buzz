import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filenamesByUrl,
  hasPendingUploads,
  markFailed,
  markUploaded,
  markUploading,
  queueFromDescriptors,
  queuedFrom,
  removeAttachment,
  uploadedDescriptors,
  withProgress,
} from "./attachmentQueue.ts";

const descriptor = (url, extra = {}) => ({
  url,
  sha256: "a".repeat(64),
  mime_type: "image/png",
  size: 2048,
  ...extra,
});

test("queuedFrom starts a row queued at zero progress", () => {
  const row = queuedFrom({ name: "shot.png", size: 10, type: "image/png" });
  assert.equal(row.status, "queued");
  assert.equal(row.progress, 0);
  assert.equal(row.name, "shot.png");
  assert.equal(row.mime, "image/png");
});

test("queuedFrom gives every row a distinct id", () => {
  const a = queuedFrom({ name: "x", size: 1, type: "image/png" });
  const b = queuedFrom({ name: "x", size: 1, type: "image/png" });
  assert.notEqual(a.id, b.id, "two identical files are two rows");
});

test("queuedFrom falls back for a nameless, typeless file", () => {
  const row = queuedFrom({ name: "", size: 0, type: "" });
  assert.equal(row.name, "attachment");
  assert.equal(row.mime, "application/octet-stream");
});

test("the queue transitions never mutate their input", () => {
  const start = [queuedFrom({ name: "a", size: 1, type: "text/plain" })];
  const uploading = markUploading(start, start[0].id);
  assert.equal(start[0].status, "queued", "original untouched");
  assert.equal(uploading[0].status, "uploading");
  assert.notEqual(start, uploading);
});

test("progress clamps to 0..1", () => {
  const queue = [queuedFrom({ name: "a", size: 1, type: "text/plain" })];
  assert.equal(withProgress(queue, queue[0].id, 0.4)[0].progress, 0.4);
  assert.equal(withProgress(queue, queue[0].id, 9)[0].progress, 1);
  assert.equal(withProgress(queue, queue[0].id, -3)[0].progress, 0);
});

test("only DONE rows contribute descriptors", () => {
  const a = queuedFrom({ name: "a", size: 1, type: "image/png" });
  const b = queuedFrom({ name: "b", size: 1, type: "image/png" });
  let queue = [a, b];
  queue = markUploaded(queue, a.id, descriptor("https://r/1.png"));
  queue = markFailed(queue, b.id, "boom");
  const urls = uploadedDescriptors(queue).map((d) => d.url);
  assert.deepEqual(urls, ["https://r/1.png"]);
});

test("hasPendingUploads is true while anything is queued or in flight", () => {
  const a = queuedFrom({ name: "a", size: 1, type: "image/png" });
  assert.equal(hasPendingUploads([a]), true, "queued counts as pending");
  const uploading = markUploading([a], a.id);
  assert.equal(hasPendingUploads(uploading), true);
  const done = markUploaded(uploading, a.id, descriptor("https://r/1.png"));
  assert.equal(hasPendingUploads(done), false);
  assert.equal(
    hasPendingUploads(markFailed(done, a.id, "boom")),
    false,
    "a failed row is not pending — it will never finish on its own",
  );
});

test("removeAttachment drops exactly one row", () => {
  const a = queuedFrom({ name: "a", size: 1, type: "image/png" });
  const b = queuedFrom({ name: "b", size: 1, type: "image/png" });
  const left = removeAttachment([a, b], a.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].id, b.id);
});

test("a restored draft comes back as finished rows with its filenames", () => {
  const queue = queueFromDescriptors(
    [descriptor("https://r/abc.png"), descriptor("https://r/def.pdf")],
    { "https://r/abc.png": "screenshot.png" },
  );
  assert.equal(queue.length, 2);
  assert.equal(queue[0].status, "done");
  assert.equal(queue[0].progress, 1);
  assert.equal(queue[0].name, "screenshot.png");
  assert.equal(queue[1].name, "def.pdf", "url tail when no name was stored");
});

test("filenamesByUrl records only rows that have a descriptor", () => {
  const a = queuedFrom({ name: "a.png", size: 1, type: "image/png" });
  const b = queuedFrom({ name: "b.png", size: 1, type: "image/png" });
  const queue = markUploaded([a, b], a.id, descriptor("https://r/1.png"));
  assert.deepEqual(filenamesByUrl(queue), { "https://r/1.png": "a.png" });
});

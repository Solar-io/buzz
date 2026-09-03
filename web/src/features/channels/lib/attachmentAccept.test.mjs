import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTACHMENT_ACCEPT,
  attachmentRejectionReason,
  FILE_MIMES,
  IMAGE_MIMES,
  VIDEO_MIMES,
} from "./attachmentAccept.ts";

test("the accept list still offers everything the image pipeline takes", () => {
  for (const mime of IMAGE_MIMES) {
    assert.ok(
      ATTACHMENT_ACCEPT.includes(mime),
      `${mime} must stay in the picker`,
    );
  }
  assert.ok(ATTACHMENT_ACCEPT.includes("video/mp4"));
  assert.equal(VIDEO_MIMES.length, 1, "the relay streams MP4 and nothing else");
});

test("the accept list now reaches the relay's generic attachment path", () => {
  // The old list was images + MP4 only, so every one of these was
  // unselectable even though `process_file_upload` stores them.
  for (const mime of [
    "application/pdf",
    "application/zip",
    "text/csv",
    "application/json",
  ]) {
    assert.ok(FILE_MIMES.includes(mime), `${mime} belongs on the file path`);
    assert.ok(ATTACHMENT_ACCEPT.includes(mime));
  }
  assert.ok(
    ATTACHMENT_ACCEPT.includes(".log"),
    "extension hints cover files browsers give no MIME for",
  );
});

test("nothing the relay's deny-list blocks is offered", () => {
  for (const mime of [
    "image/svg+xml",
    "application/javascript",
    "application/x-msdownload",
    "application/vnd.android.package-archive",
  ]) {
    assert.ok(
      !ATTACHMENT_ACCEPT.includes(mime),
      `${mime} is on BLOCKED_FILE_MIME_TYPES and must not be offered`,
    );
  }
  assert.ok(
    !ATTACHMENT_ACCEPT.includes("audio/"),
    "audio has no sanitizer server-side and is rejected outright",
  );
});

test("audio is pre-flighted as rejected, with the reason the relay has", () => {
  assert.equal(
    attachmentRejectionReason({ name: "a.mp3", type: "audio/mpeg" }),
    "Audio uploads are not accepted yet.",
  );
});

test("stored-XSS carriers and executables are pre-flighted as rejected", () => {
  assert.match(
    attachmentRejectionReason({ name: "x.svg", type: "image/svg+xml" }) ?? "",
    /blocked/i,
  );
  assert.match(
    attachmentRejectionReason({
      name: "x.apk",
      type: "application/vnd.android.package-archive",
    }) ?? "",
    /blocked/i,
  );
});

test("non-MP4 video and non-pipeline images are pre-flighted as rejected", () => {
  assert.match(
    attachmentRejectionReason({ name: "a.mov", type: "video/quicktime" }) ?? "",
    /MP4/,
  );
  assert.match(
    attachmentRejectionReason({ name: "a.avif", type: "image/avif" }) ?? "",
    /JPEG, PNG, GIF or WebP/,
  );
});

test("documents, archives and unlabelled files pass the pre-flight", () => {
  assert.equal(
    attachmentRejectionReason({ name: "r.pdf", type: "application/pdf" }),
    null,
  );
  assert.equal(
    attachmentRejectionReason({ name: "a.zip", type: "application/zip" }),
    null,
  );
  assert.equal(
    attachmentRejectionReason({ name: "notes.log", type: "" }),
    null,
    "no browser MIME is not a reason to refuse — the relay stores it opaque",
  );
  assert.equal(
    attachmentRejectionReason({ name: "a.png", type: "image/png" }),
    null,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptAvatarDescriptor } from "./avatarUpload.ts";

test("an image descriptor with an https url is accepted", () => {
  assert.deepEqual(
    acceptAvatarDescriptor({
      url: "https://blossom.example/abc.png",
      mime_type: "image/png",
    }),
    { url: "https://blossom.example/abc.png" },
  );
});

test("a non-image mime is refused", () => {
  assert.deepEqual(
    acceptAvatarDescriptor({
      url: "https://blossom.example/abc.mp4",
      mime_type: "video/mp4",
    }),
    { error: "Choose a PNG, JPG, GIF, or WebP image." },
  );
});

test("a non-http url is refused", () => {
  assert.deepEqual(
    acceptAvatarDescriptor({
      url: "javascript:alert(1)",
      mime_type: "image/png",
    }),
    { error: "The upload returned a non-http URL." },
  );
  assert.deepEqual(
    acceptAvatarDescriptor({ url: "not a url", mime_type: "image/png" }),
    { error: "The upload returned an invalid URL." },
  );
});

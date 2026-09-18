import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dragCarriesFiles,
  FOLDER_REJECTION_REASON,
  partitionDropFiles,
} from "./attachmentDrop.ts";

// Node's File (available since 20) — the same shape a drop hands over.
function file(name, type, size = 10) {
  return new File(["x".repeat(size)], name, { type });
}

test("a mixed drop keeps accepted files in order and rejects the rule-breakers", () => {
  const png = file("shot.png", "image/png");
  const mp3 = file("voice.mp3", "audio/mpeg");
  const svg = file("logo.svg", "image/svg+xml");
  const txt = file("notes.txt", "text/plain");

  const { accepted, rejections } = partitionDropFiles([png, mp3, svg, txt]);

  assert.deepEqual(accepted, [png, txt], "accepted keeps drop order");
  assert.deepEqual(
    rejections.map(({ name }) => name),
    ["voice.mp3", "logo.svg"],
  );
  assert.match(rejections[0].reason, /Audio/);
  assert.match(rejections[1].reason, /blocked/);
});

test("a folder entry is rejected with a reason that says what to do instead", () => {
  // What Chromium hands over for a dropped directory: File-shaped, no MIME,
  // zero bytes, and no extension in the name.
  const folder = file("Photos", "", 0);

  const { accepted, rejections } = partitionDropFiles([folder]);

  assert.deepEqual(accepted, []);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].name, "Photos");
  assert.equal(rejections[0].reason, FOLDER_REJECTION_REASON);
});

test("an empty dot-file is a file, not a folder — .gitkeep still attaches", () => {
  const gitkeep = file(".gitkeep", "", 0);

  const { accepted, rejections } = partitionDropFiles([gitkeep]);

  assert.deepEqual(accepted, [gitkeep]);
  assert.deepEqual(rejections, []);
});

test("an empty drop partitions to nothing — no accepted rows, no rejections", () => {
  const { accepted, rejections } = partitionDropFiles([]);
  assert.deepEqual(accepted, []);
  assert.deepEqual(rejections, []);
});

test("dragCarriesFiles reads the dragover-safe type list, and only that", () => {
  assert.equal(dragCarriesFiles({ types: ["Files"] }), true);
  assert.equal(
    dragCarriesFiles({ types: ["Files", "text/uri-list"] }),
    true,
    "a file drag may carry URL flavour too",
  );
  assert.equal(dragCarriesFiles({ types: ["text/plain"] }), false);
  assert.equal(dragCarriesFiles({ types: ["text/uri-list"] }), false);
  assert.equal(dragCarriesFiles(null), false);
});

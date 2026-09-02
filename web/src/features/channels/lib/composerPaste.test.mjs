import assert from "node:assert/strict";
import { test } from "node:test";
import { imageFilesFromClipboard } from "./composerPaste.ts";

function fakeFile(name, type, size) {
  return { name, type, size };
}

function fakeData({ files = [], items = [] }) {
  return {
    files,
    items: items.map((entry) =>
      typeof entry === "object" && "getAsFile" in entry
        ? entry
        : { kind: "file", getAsFile: () => entry },
    ),
  };
}

test("image files from clipboardData.files are taken", () => {
  const png = fakeFile("shot.png", "image/png", 12_345);
  const jpg = fakeFile("photo.jpg", "image/jpeg", 99);
  const out = imageFilesFromClipboard(fakeData({ files: [png, jpg] }));
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "shot.png");
  assert.equal(out[1].name, "photo.jpg");
});

test("non-image files and empty clipboards are ignored", () => {
  assert.equal(
    imageFilesFromClipboard(
      fakeData({
        files: [fakeFile("doc.pdf", "application/pdf", 500)],
      }),
    ).length,
    0,
  );
  assert.equal(imageFilesFromClipboard(null).length, 0);
  assert.equal(imageFilesFromClipboard(fakeData({})).length, 0);
});

test("items-only clipboards (Safari copied images) are covered", () => {
  const shot = fakeFile("image.png", "image/png", 4_000);
  const out = imageFilesFromClipboard(fakeData({ items: [shot] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "image.png");
});

test("the same file in files and items is deduped, not pasted twice", () => {
  const shot = fakeFile("image.png", "image/png", 4_000);
  const out = imageFilesFromClipboard(
    fakeData({ files: [shot], items: [shot] }),
  );
  assert.equal(out.length, 1);
});

test("non-file items (text) never throw and contribute nothing", () => {
  const data = {
    files: [],
    items: [
      { kind: "string", type: "text/plain" },
      { kind: "string", type: "text/html" },
    ],
  };
  assert.equal(imageFilesFromClipboard(data).length, 0);
});

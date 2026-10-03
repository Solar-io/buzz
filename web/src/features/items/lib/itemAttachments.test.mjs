import assert from "node:assert/strict";
import { test } from "node:test";
import {
  insertItemAttachment,
  itemAttachmentMarkdown,
  itemBodyBytes,
} from "./itemAttachments.ts";
import { filesFromClipboard } from "../../channels/lib/composerPaste.ts";

const descriptor = {
  url: "https://media.test/shot.png",
  mime_type: "image/png",
  size: 10,
  sha256: "a".repeat(64),
};

test("item markdown embeds images with their filename and links every other type", () => {
  assert.equal(
    itemAttachmentMarkdown(descriptor, "shot.png"),
    "![shot.png](https://media.test/shot.png)",
  );
  for (const mime of [
    "text/plain",
    "application/pdf",
    "audio/mpeg",
    "video/mp4",
  ]) {
    assert.equal(
      itemAttachmentMarkdown(
        { ...descriptor, mime_type: mime },
        "evidence.pdf",
      ),
      "[evidence.pdf](https://media.test/shot.png)",
    );
  }
});
test("item markdown contains hostile labels and destination punctuation", () => {
  const markdown = itemAttachmentMarkdown(
    { ...descriptor, url: "https://media.test/a(b) c.png" },
    "[bad]\\`*\nname.png",
  );
  assert.equal(
    markdown,
    "![bad\\\\\\`\\* name.png](https://media.test/a%28b%29%20c.png)",
  );
  assert.equal(
    itemAttachmentMarkdown(descriptor, "[ ]"),
    "![attachment](https://media.test/shot.png)",
  );
});
test("item insertion replaces the selection and preserves both sides and cursor", () => {
  const result = insertItemAttachment(
    "before selected after",
    7,
    15,
    "![shot](url)",
  );
  assert.equal(result.body, "before \n![shot](url)\n after");
  assert.equal(result.cursor, 21);
});
test("item insertion keeps batch order without extra blank lines", () => {
  const a = insertItemAttachment("", 0, 0, "![one](a)");
  const b = insertItemAttachment(a.body, a.cursor, a.cursor, "[two](b)");
  assert.equal(b.body, "![one](a)\n[two](b)\n");
});
test("item insertion enforces the fixed 16384 byte bound on multibyte prose", () => {
  assert.equal(itemBodyBytes("😀é"), 6);
  const body = "é".repeat(8189);
  assert.equal(
    itemBodyBytes(
      insertItemAttachment(body, body.length, body.length, "[x]").body,
    ),
    16383,
  );
  assert.throws(
    () =>
      insertItemAttachment(`${body}é`, body.length + 1, body.length + 1, "[x]"),
    /16384 bytes/,
  );
});
test("item clipboard accepts documents and images from both views once, leaving text alone", () => {
  const file = { name: "evidence.pdf", type: "application/pdf", size: 10 };
  assert.deepEqual(
    filesFromClipboard({
      files: [file],
      items: [{ kind: "file", getAsFile: () => file }, { kind: "string" }],
    }),
    [file],
  );
  assert.deepEqual(filesFromClipboard(null), []);
});

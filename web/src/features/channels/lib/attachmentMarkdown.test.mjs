import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachmentMarkdown,
  composeSendContent,
  formatAttachmentSize,
  isInlineMedia,
  removeAttachmentMarkdown,
  stripAttachmentsMarkdown,
} from "./attachmentMarkdown.ts";

const descriptor = (mime, url) => ({
  url,
  sha256: "b".repeat(64),
  mime_type: mime,
  size: 100,
});

test("images and video keep the inline embed shape", () => {
  const image = descriptor("image/png", "https://r/1.png");
  assert.equal(isInlineMedia(image), true);
  assert.equal(
    attachmentMarkdown(image, "shot.png"),
    "\n![image](https://r/1.png)",
  );
  const video = descriptor("video/mp4", "https://r/2.mp4");
  assert.equal(
    attachmentMarkdown(video, "clip.mp4"),
    "\n![video](https://r/2.mp4)",
  );
});

test("a generic file becomes a named link, not an image embed", () => {
  const pdf = descriptor("application/pdf", "https://r/3.pdf");
  assert.equal(isInlineMedia(pdf), false);
  assert.equal(
    attachmentMarkdown(pdf, "Q3 report.pdf"),
    "\n[Q3 report.pdf](https://r/3.pdf)",
  );
});

test("a filename that would break the link label is sanitised", () => {
  const pdf = descriptor("application/pdf", "https://r/4.pdf");
  assert.equal(
    attachmentMarkdown(pdf, "we[i]rd\nname.pdf"),
    "\n[weird name.pdf](https://r/4.pdf)",
  );
  assert.equal(
    attachmentMarkdown(pdf, "   "),
    "\n[attachment](https://r/4.pdf)",
    "a blank name still produces a usable label",
  );
});

test("removing an attachment strips its embed and the newline before it", () => {
  const text = "look\n![image](https://r/1.png)\nand more";
  assert.equal(
    removeAttachmentMarkdown(text, "https://r/1.png"),
    "look\nand more",
  );
});

test("removing an attachment strips a file link too", () => {
  const text = "here\n[report.pdf](https://r/3.pdf)";
  assert.equal(removeAttachmentMarkdown(text, "https://r/3.pdf"), "here");
});

test("removing one attachment leaves the others alone", () => {
  const text = "\n![image](https://r/1.png)\n![image](https://r/2.png)";
  assert.equal(
    removeAttachmentMarkdown(text, "https://r/1.png"),
    "\n![image](https://r/2.png)",
  );
});

test("a url with regex metacharacters is matched literally", () => {
  const url = "https://r/a+b(c).png";
  const text = `x\n![image](${url})`;
  assert.equal(removeAttachmentMarkdown(text, url), "x");
  assert.equal(
    removeAttachmentMarkdown("x\n![image](https://r/aXbXcX.png)", url),
    "x\n![image](https://r/aXbXcX.png)",
    "the escaped pattern must not match a look-alike url",
  );
});

test("attachment sizes render in the unit that fits", () => {
  assert.equal(formatAttachmentSize(512), "512 B");
  assert.equal(formatAttachmentSize(2048), "2.0 KB");
  assert.equal(formatAttachmentSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatAttachmentSize(Number.NaN), "");
});

test("composeSendContent appends each attachment after the typed text", () => {
  const image = descriptor("image/png", "https://r/1.png");
  const pdf = descriptor("application/pdf", "https://r/3.pdf");
  assert.equal(
    composeSendContent("look at this", [image, pdf], {
      "https://r/3.pdf": "Q3 report.pdf",
    }),
    "look at this\n![image](https://r/1.png)\n[Q3 report.pdf](https://r/3.pdf)",
  );
});

test("composeSendContent works with nothing typed — the attachment alone is the message", () => {
  const image = descriptor("image/png", "https://r/1.png");
  assert.equal(
    composeSendContent("  ", [image], {}),
    "\n![image](https://r/1.png)",
    "whitespace-only text still sends as attachment-only",
  );
  assert.equal(composeSendContent("", [], {}), "", "empty stays empty");
});

test("composeSendContent never duplicates markdown an old draft already carries", () => {
  const pdf = descriptor("application/pdf", "https://r/3.pdf");
  const staleDraftText = "here\n[Q3 report.pdf](https://r/3.pdf)";
  assert.equal(
    composeSendContent(staleDraftText, [pdf], {
      "https://r/3.pdf": "Q3 report.pdf",
    }),
    "here\n[Q3 report.pdf](https://r/3.pdf)",
    "the link already in the text must not be appended a second time",
  );
});

test("composeSendContent trims trailing whitespace off the typed text", () => {
  const image = descriptor("image/png", "https://r/1.png");
  assert.equal(
    composeSendContent("hi\n\n", [image], {}),
    "hi\n![image](https://r/1.png)",
  );
});

test("stripAttachmentsMarkdown migrates an old draft's text to the tray-only shape", () => {
  const image = descriptor("image/png", "https://r/1.png");
  const pdf = descriptor("application/pdf", "https://r/3.pdf");
  const stale =
    "see this\n![image](https://r/1.png)\n[report.pdf](https://r/3.pdf)\nand that";
  assert.equal(
    stripAttachmentsMarkdown(stale, [image, pdf]),
    "see this\nand that",
  );
});

test("stripAttachmentsMarkdown leaves links the author typed themselves", () => {
  const image = descriptor("image/png", "https://r/1.png");
  const text = "see\n![image](https://r/other.png)";
  assert.equal(
    stripAttachmentsMarkdown(text, [image]),
    text,
    "no descriptor, no strip — an unrelated link survives",
  );
});

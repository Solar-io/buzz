import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bracketedPaths,
  clipboardHasFiles,
  MAX_BRACKETED_PASTE_FRAME_BYTES,
  pastedName,
  shellEscapePath,
  splitOversizedBracketedPaste,
  uploadAndBuildPaste,
} from "./pasteUpload.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const START = "\x1b[200~";
const END = "\x1b[201~";

test("a small or unbracketed payload goes out as ONE frame, untouched", () => {
  const small = enc.encode(`${START}hello${END}`);
  assert.deepEqual(splitOversizedBracketedPaste(small), [small]);
  const big = new Uint8Array(MAX_BRACKETED_PASTE_FRAME_BYTES + 10).fill(0x61);
  assert.equal(
    splitOversizedBracketedPaste(big).length,
    1,
    "not bracketed: not ours to split",
  );
});

test("ADR-101: an oversized bracketed paste splits into COMPLETE bracketed frames", () => {
  // 1.2 MB of "é" (2 bytes each): every cut must land on a codepoint boundary.
  const text = "é".repeat(600_000);
  const frames = splitOversizedBracketedPaste(
    enc.encode(`${START}${text}${END}`),
  );
  assert.equal(frames.length, 3);
  let rebuilt = "";
  for (const frame of frames) {
    assert.ok(frame.length <= MAX_BRACKETED_PASTE_FRAME_BYTES);
    const s = dec.decode(frame, { fatal: true });
    assert.ok(
      s.startsWith(START) && s.endsWith(END),
      "every frame closes its paste",
    );
    rebuilt += s.slice(START.length, -END.length);
  }
  assert.equal(rebuilt, text);
});

test("paths are escaped and each one is its own bracketed paste, never submitted", () => {
  assert.equal(
    shellEscapePath("/Users/sam/My File (1).png"),
    "/Users/sam/My\\ File\\ \\(1\\).png",
  );
  assert.equal(
    bracketedPaths(["/a/b.png", "/c d.txt"]),
    `${START}/a/b.png${END} ${START}/c\\ d.txt${END}`,
  );
  assert.ok(!bracketedPaths(["/a"]).includes("\r"));
});

test("only a clipboard with FILES is claimed; text pastes pass through", () => {
  assert.equal(clipboardHasFiles({ types: ["text/plain"] }), false);
  assert.equal(clipboardHasFiles({ types: ["Files"] }), true);
  assert.equal(
    clipboardHasFiles({ types: [], items: [{ kind: "file" }] }),
    true,
  );
  assert.equal(clipboardHasFiles(null), false);
});

test("a screenshot's generic name becomes a sortable one; a real name is kept", () => {
  const now = new Date(2026, 8, 30, 14, 2, 7);
  assert.equal(
    pastedName({ name: "image.png", type: "image/png" }, 0, now),
    "pasted-2026-09-30T14-02-07.png",
  );
  assert.equal(
    pastedName({ name: "", type: "image/jpeg" }, 1, now),
    "pasted-2026-09-30T14-02-07-1.jpg",
  );
  assert.equal(
    pastedName({ name: "report.pdf", type: "application/pdf" }, 0, now),
    "report.pdf",
  );
});

test("upload then type: paths for what landed, failures reported, nothing thrown", async () => {
  const files = [
    { name: "a.png", type: "image/png" },
    { name: "b.png", type: "image/png" },
  ];
  const outcome = await uploadAndBuildPaste(files, async (_file, name) => {
    if (name === "b.png") throw new Error("too large");
    return `/Users/sam/.hatch/uploads/2026-09-30/${name}`;
  });
  assert.deepEqual(outcome.paths, [
    "/Users/sam/.hatch/uploads/2026-09-30/a.png",
  ]);
  assert.deepEqual(outcome.failed, [{ name: "b.png", error: "too large" }]);
  assert.equal(
    outcome.bytes,
    `${START}/Users/sam/.hatch/uploads/2026-09-30/a.png${END}`,
  );
});

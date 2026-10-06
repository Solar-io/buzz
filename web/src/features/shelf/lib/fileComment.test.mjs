import assert from "node:assert/strict";
import test from "node:test";

import { parseDelimited } from "./csv.ts";
import {
  agentRequest,
  cleanQuote,
  commentTree,
  fileTrailer,
  quotedComment,
  splitAgentRequest,
  splitFileTrailer,
  splitQuotedComment,
} from "./fileComment.ts";
import { fileSourceOf, openFileFromSource, sourcePath } from "./fileSource.ts";

test("a highlight rides as a leading quote and splits back out", () => {
  const content = quotedComment(
    "Top effort decided both creative rounds",
    "  Re-run C with audio on before 10/8. ",
  );
  assert.equal(
    content,
    "> Top effort decided both creative rounds\n\nRe-run C with audio on before 10/8.",
  );
  assert.deepEqual(splitQuotedComment(content), {
    quote: "Top effort decided both creative rounds",
    body: "Re-run C with audio on before 10/8.",
  });
  assert.deepEqual(splitQuotedComment("plain note"), {
    quote: null,
    body: "plain note",
  });
  // Only a quote: that is the comment, not a highlight with no words.
  assert.deepEqual(splitQuotedComment("> just this"), {
    quote: null,
    body: "> just this",
  });
  assert.equal(cleanQuote("  a\n\n b  "), "a b");
  assert.equal(cleanQuote("   "), null);
  assert.equal(cleanQuote("x".repeat(400)).length, 280);
});

test("replies fold under the note they answer, never nesting twice", () => {
  const note = { id: "n1", replyToId: "share", createdAt: 10 };
  const later = { id: "n2", replyToId: "share", createdAt: 30 };
  const answer = { id: "r1", replyToId: "n1", createdAt: 20 };
  const answerToAnswer = { id: "r2", replyToId: "r1", createdAt: 25 };
  const tree = commentTree([later, answerToAnswer, answer, note]);
  assert.deepEqual(
    tree.map((node) => [node.comment.id, node.replies.map((r) => r.id)]),
    [
      ["n1", ["r1", "r2"]],
      ["n2", []],
    ],
  );
});

test("CSV: quotes, separators and newlines inside quotes, CRLF, a bound", () => {
  const { rows, truncated } = parseDelimited(
    'game,model,score\r\nC,"Sol, max",5\nD,"Opus\nxhigh",4\n"say ""hi""",x,1\n',
    ",",
  );
  assert.deepEqual(rows, [
    ["game", "model", "score"],
    ["C", "Sol, max", "5"],
    ["D", "Opus\nxhigh", "4"],
    ['say "hi"', "x", "1"],
  ]);
  assert.equal(truncated, false);
  const tsv = parseDelimited("a\tb\n1\t2", "\t");
  assert.deepEqual(tsv.rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
  const many = parseDelimited("r\n".repeat(10), ",", 4);
  assert.equal(many.rows.length, 4);
  assert.equal(many.truncated, true);
});

test("a tile's file source pairs its paths and keys its tab by message", () => {
  const message = {
    id: "m",
    channelId: "c",
    authorPubkey: "a",
    createdAt: 5,
    rootId: null,
    replyToId: null,
    imetaByUrl: new Map([
      ["https://r/1", {}],
      ["https://r/2", { x: "ab".repeat(32) }],
    ]),
    shelf: { paths: ["crichton:/x/a.md", "crichton:/x/b.html"] },
  };
  const source = fileSourceOf(message);
  assert.equal(source.shelf, true);
  assert.deepEqual(sourcePath(source, "https://r/2"), {
    host: "crichton",
    path: "/x/b.html",
  });
  assert.equal(sourcePath(source, "https://r/9"), null);
  const open = openFileFromSource(source, {
    href: "https://r/2",
    filename: "b.html",
    size: 9,
    mime: "text/html",
  });
  assert.equal(open.key, "m|https://r/2");
  assert.equal(open.path, "crichton:/x/b.html");
  assert.equal(
    open.sha256,
    "abababababababababababababababababababababababababababababababab",
  );
  assert.equal(
    openFileFromSource(source, { href: "https://r/1", filename: "a.md" })
      .sha256,
    null,
  );
  // A row cached before Phase 6 has no `shelf`: not a share, no paths.
  const cached = fileSourceOf({ ...message, shelf: undefined });
  assert.equal(cached.shelf, false);
  assert.equal(sourcePath(cached, "https://r/2"), null);
  // Outside a message: a bare file, no thread.
  assert.equal(
    openFileFromSource(null, { href: "u", filename: "f" }).key,
    "-|u",
  );
});

test("trailer built, split off and shown (never silently dropped)", () => {
  const ctx = {
    filename: "report.md",
    path: "crichton:/Users/sam/docs/report.md",
    editedSinceShared: false,
  };
  const content = agentRequest("Q3 table", "  Fix the dates. ", ctx);
  assert.equal(
    content,
    "> Q3 table\n\nFix the dates.\n\n[file: report.md · crichton:/Users/sam/docs/report.md]",
  );
  assert.equal(
    fileTrailer({ ...ctx, editedSinceShared: true }),
    "[file: report.md · crichton:/Users/sam/docs/report.md · edited by you since shared]",
  );
  assert.equal(
    fileTrailer({
      filename: "notes.txt",
      path: null,
      editedSinceShared: false,
    }),
    "[file: notes.txt]",
  );
  assert.deepEqual(splitAgentRequest(content), {
    quote: "Q3 table",
    body: "Fix the dates.",
    file: "report.md · crichton:/Users/sam/docs/report.md",
  });
  // A trailer-shaped line anywhere but last is the person's text.
  const mid = "see [file: x]\n[file: x]\nthen fix it";
  assert.deepEqual(splitFileTrailer(mid), { text: mid, file: null });
  assert.deepEqual(splitFileTrailer("[file: x] is the name"), {
    text: "[file: x] is the name",
    file: null,
  });
  assert.deepEqual(splitFileTrailer("plain\n\n[file: a.md]"), {
    text: "plain",
    file: "a.md",
  });
  // A name with brackets cannot break the shape.
  assert.equal(
    fileTrailer({ filename: "a]b.md", path: null, editedSinceShared: false }),
    "[file: a b.md]",
  );
});

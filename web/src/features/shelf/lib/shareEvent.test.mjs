import assert from "node:assert/strict";
import test from "node:test";

import { timelineMessageFromEvent } from "../../channels/lib/messageBuffer.ts";
import {
  commentThreadRef,
  commonFolder,
  compressedNames,
  displayPath,
  distinguishingParts,
  filesTarget,
  folderCrumbs,
  openFileOf,
  pairPaths,
  parseShare,
  parseSharePath,
  shareSummary,
} from "./shareEvent.ts";

const CH = "20000000-0000-4000-8000-000000000001";
const AGENT = "b".repeat(64);
const MD = `https://relay.test/media/${"1".repeat(64)}.bin`;
const HTML = `https://relay.test/media/${"2".repeat(64)}.bin`;
const PNG = `https://relay.test/media/${"3".repeat(64)}.png`;
const DIR = "/Users/sgallant/MEGA/shared_files/dropbox/rts-bakeoff";

/** A share exactly as `buzz share a.md b.html c.png --summary …` emits it. */
function cliShare(overrides = {}) {
  return {
    id: "a".repeat(64),
    pubkey: AGENT,
    created_at: 1_759_190_400,
    kind: 9,
    content:
      `Scores, winner and takeaways for the RTS build\n` +
      `[bakeoff-results.md](${MD})\n[game-C.html](${HTML})\n![image](${PNG})`,
    tags: [
      ["h", CH],
      [
        "imeta",
        `url ${MD}`,
        "m application/octet-stream",
        `x ${"1".repeat(64)}`,
        "size 4210",
        "filename bakeoff-results.md",
      ],
      [
        "imeta",
        `url ${HTML}`,
        "m application/octet-stream",
        "size 94208",
        "filename game-C.html",
      ],
      [
        "imeta",
        `url ${PNG}`,
        "m image/png",
        "size 81234",
        "dim 800x600",
        "filename chart.png",
      ],
      ["t", "shelf"],
      ["path", `crichton:${DIR}/bakeoff-results.md`],
      ["path", `crichton:${DIR}/game-C.html`],
      ["path", `crichton:${DIR}/chart.png`],
      ["session", "slot-1"],
    ],
    sig: "c".repeat(128),
    ...overrides,
  };
}

test("a CLI share parses into files typed by extension, with paths in imeta order", () => {
  const share = parseShare(cliShare());
  assert.ok(share);
  assert.equal(share.channelId, CH);
  assert.equal(share.authorPubkey, AGENT);
  assert.equal(share.files.length, 3);
  assert.deepEqual(
    share.files.map((file) => [file.filename, file.kind, file.size]),
    [
      ["bakeoff-results.md", "markdown", 4210],
      ["game-C.html", "html", 94208],
      ["chart.png", "image", 81234],
    ],
  );
  // `m` stays the stored type; the extension decided the kind.
  assert.equal(share.files[0].mime, "application/octet-stream");
  assert.deepEqual(share.files[1].path, {
    host: "crichton",
    path: `${DIR}/game-C.html`,
  });
  assert.equal(share.summary, "Scores, winner and takeaways for the RTS build");
  assert.equal(share.rootId, null);
  assert.equal(share.replyToId, null);
});

test("only a kind 9 with the shelf marker, a channel and a file is a share", () => {
  const base = cliShare();
  assert.equal(
    parseShare({ ...base, tags: base.tags.filter((tag) => tag[0] !== "t") }),
    null,
  );
  assert.equal(
    parseShare({
      ...base,
      tags: base.tags.map((tag) => (tag[0] === "t" ? ["t", "shelves"] : tag)),
    }),
    null,
  );
  assert.equal(parseShare({ ...base, kind: 7 }), null);
  assert.equal(
    parseShare({ ...base, tags: base.tags.filter((tag) => tag[0] !== "h") }),
    null,
  );
  assert.equal(
    parseShare({
      ...base,
      tags: base.tags.filter((tag) => tag[0] !== "imeta"),
    }),
    null,
  );
});

test("a filename falls back to the link label, then the URL tail", () => {
  const share = parseShare(
    cliShare({
      content: `notes\n[weekly report.md](${MD})`,
      tags: [
        ["h", CH],
        ["imeta", `url ${MD}`, "m application/octet-stream"],
        ["imeta", `url ${HTML}`, "m text/html"],
        ["t", "shelf"],
      ],
    }),
  );
  assert.deepEqual(
    share.files.map((file) => file.filename),
    ["weekly report.md", `${"2".repeat(64)}.bin`],
  );
  // No extension, but text/html: still a web page.
  assert.equal(share.files[1].kind, "html");
});

test("paths pair by position only when there is one per file", () => {
  assert.deepEqual(pairPaths(2, ["crichton:/a", "crichton:/b"]), [
    { host: "crichton", path: "/a" },
    { host: "crichton", path: "/b" },
  ]);
  assert.deepEqual(pairPaths(3, ["crichton:/a"]), [null, null, null]);
  assert.deepEqual(pairPaths(1, []), [null]);
});

test("a path tag must be host:/absolute with no control characters", () => {
  assert.deepEqual(parseSharePath("crichton:/Users/sam/x.md"), {
    host: "crichton",
    path: "/Users/sam/x.md",
  });
  assert.equal(parseSharePath("crichton:~/x.md"), null);
  assert.equal(parseSharePath("crichton:relative/x.md"), null);
  assert.equal(parseSharePath("/no/host"), null);
  assert.equal(parseSharePath("bad host:/x"), null);
  assert.equal(parseSharePath("crichton:/a\nb"), null);
  assert.equal(parseSharePath(42), null);
});

test("the summary is the prose without the attachment links", () => {
  assert.equal(
    shareSummary(`![image](${PNG})`, [PNG]),
    "",
    "a share with no summary has none",
  );
  assert.equal(
    shareSummary(`see [a.md](${MD}) and [other](https://x.test)`, [MD]),
    "see and [other](https://x.test)",
  );
});

test("a comment roots at the share, or at the share's own thread root", () => {
  assert.deepEqual(
    commentThreadRef({ id: "s", rootId: null, replyToId: null }),
    { rootId: "s", replyToId: "s" },
  );
  // The share itself answered an earlier message: same thread, never self-rooted.
  assert.deepEqual(commentThreadRef({ id: "s", rootId: "r", replyToId: "p" }), {
    rootId: "r",
    replyToId: "s",
  });
  assert.deepEqual(
    commentThreadRef({ id: "s", rootId: null, replyToId: "p" }),
    { rootId: "p", replyToId: "s" },
  );
});

test("a series of names compresses to the part that differs", () => {
  const games = ["game-A.html", "game-B.html", "game-C.html", "game-D.html"];
  assert.deepEqual(distinguishingParts(games), ["A", "B", "C", "D"]);
  assert.equal(compressedNames(games), "game-A…D.html");
  assert.equal(compressedNames(["report.md"]), "report.md");
  assert.equal(compressedNames(["a.md", "notes.txt"]), "2 files");
  assert.equal(
    distinguishingParts(["summary-final.md", "summary-draft.md"]),
    null,
    "long parts are not thumbnails",
  );
});

test("folders: one common folder, crumbs from home, ~ for the home dir", () => {
  const share = parseShare(cliShare());
  const folder = commonFolder(share.files.map((file) => file.path));
  assert.deepEqual(folder, { host: "crichton", path: DIR });
  assert.deepEqual(folderCrumbs(DIR), [
    "MEGA",
    "shared_files",
    "dropbox",
    "rts-bakeoff",
  ]);
  assert.equal(
    displayPath(`${DIR}/game-C.html`),
    "~/MEGA/shared_files/dropbox/rts-bakeoff/game-C.html",
  );
  assert.equal(displayPath("/srv/data/x.csv"), "/srv/data/x.csv");
  assert.equal(
    commonFolder([
      { host: "crichton", path: "/a/x" },
      { host: "crichton", path: "/b/y" },
    ]),
    null,
  );
  assert.equal(commonFolder([{ host: "crichton", path: "/a/x" }, null]), null);
});

test("Open in Files only for a path on the host the Files panel serves", () => {
  const path = { host: "crichton", path: "/Users/sam/x.md" };
  assert.equal(
    filesTarget(path, "https://crichton.tailb3d4b8.ts.net:6401/"),
    "/Users/sam/x.md",
  );
  assert.equal(filesTarget(path, "https://crichton:6401"), "/Users/sam/x.md");
  assert.equal(filesTarget(path, "https://pilot.tailb3d4b8.ts.net/"), null);
  assert.equal(filesTarget(path, ""), null);
  assert.equal(filesTarget(null, "https://crichton:6401"), null);
});

test("a file tab carries the share's thread markers and its path", () => {
  const share = parseShare(cliShare());
  const open = openFileOf(share, share.files[1]);
  assert.equal(open.key, `${"a".repeat(64)}|${HTML}`);
  assert.equal(open.messageId, "a".repeat(64));
  assert.equal(open.path, `crichton:${DIR}/game-C.html`);
  // W9: the shared bytes' sha256 rides on the tab (null when imeta has no x).
  assert.equal(open.sha256, null);
  assert.equal(
    openFileOf(share, share.files[0]).sha256,
    "1111111111111111111111111111111111111111111111111111111111111111",
  );
});

test("the timeline marks a share and keeps its path tags; a plain message is not one", () => {
  const share = timelineMessageFromEvent(cliShare());
  assert.deepEqual(share.shelf, {
    paths: [
      `crichton:${DIR}/bakeoff-results.md`,
      `crichton:${DIR}/game-C.html`,
      `crichton:${DIR}/chart.png`,
    ],
  });
  const plain = timelineMessageFromEvent({
    ...cliShare(),
    tags: cliShare().tags.filter((tag) => tag[0] !== "t"),
  });
  assert.equal(plain.shelf, null);
});

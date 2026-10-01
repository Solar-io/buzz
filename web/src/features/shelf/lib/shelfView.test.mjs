import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SHELF_FILTERS,
  dayLabel,
  filterShares,
  groupByDay,
  newShareCount,
  senderOptions,
  sortShares,
  whenLabel,
} from "./shelfView.ts";

const ME = "a".repeat(64);
const GILFOYLE = "b".repeat(64);
const NIKON = "c".repeat(64);
const DM = "dm-gilfoyle";
const FLIGHT = "flight-path";

/** Local wall-clock seconds, so day grouping holds in any time zone. */
function at(daysAgo, hour, minute = 0) {
  const date = new Date(2026, 8, 30, hour, minute);
  date.setDate(date.getDate() - daysAgo);
  return Math.floor(date.getTime() / 1000);
}
const NOW = at(0, 21, 30);

function file(filename, kind) {
  return {
    url: `https://r/${filename}`,
    filename,
    mime: null,
    size: 100,
    sha256: null,
    dim: null,
    kind,
    path: null,
  };
}

function share(id, author, channelId, createdAt, files, summary = "") {
  return {
    id,
    channelId,
    authorPubkey: author,
    createdAt,
    summary,
    files,
    rootId: null,
    replyToId: null,
  };
}

const SHARES = [
  share(
    "s1",
    GILFOYLE,
    DM,
    at(0, 21, 4),
    [file("bakeoff-results.md", "markdown")],
    "Scores and takeaways",
  ),
  share("s2", GILFOYLE, DM, at(0, 20, 37), [
    file("game-A.html", "html"),
    file("game-B.html", "html"),
    file("HOWTO.md", "markdown"),
  ]),
  share("s3", NIKON, FLIGHT, at(0, 15, 29), [
    file("beat-02-capture.png", "image"),
  ]),
  share("s4", ME, FLIGHT, at(1, 9, 0), [file("trace.json", "data")]),
  share("s5", GILFOYLE, FLIGHT, at(3, 12, 0), [file("main.rs", "code")]),
];

const CONTEXT = {
  selfPubkey: ME,
  channelName: (id) => (id === DM ? "DM Gilfoyle" : `#${id}`),
  personName: (pk) =>
    pk === GILFOYLE ? "Gilfoyle" : pk === NIKON ? "Lord Nikon" : "Sam",
};

test("newest first, every file counted, a chip count per type", () => {
  const result = filterShares(SHARES, DEFAULT_SHELF_FILTERS, CONTEXT);
  assert.deepEqual(
    result.rows.map((row) => row.share.id),
    ["s1", "s2", "s3", "s4", "s5"],
  );
  assert.equal(result.counts.all, 7);
  assert.equal(result.counts.docs, 2);
  assert.equal(result.counts.web, 2);
  assert.equal(result.counts.images, 1);
  assert.equal(result.counts.data, 1);
  assert.equal(result.counts.code, 1);
});

test("a type chip narrows a share to its matching files; counts ignore the type", () => {
  const result = filterShares(
    SHARES,
    { ...DEFAULT_SHELF_FILTERS, category: "web" },
    CONTEXT,
  );
  assert.deepEqual(
    result.rows.map((row) => [row.share.id, row.files.map((f) => f.filename)]),
    [["s2", ["game-A.html", "game-B.html"]]],
  );
  // The chips still say what each would show.
  assert.equal(result.counts.docs, 2);
  assert.equal(result.counts.all, 7);
});

test("sender, channel and text filters apply before counting", () => {
  const fromGilfoyle = filterShares(
    SHARES,
    { ...DEFAULT_SHELF_FILTERS, sender: { pubkey: GILFOYLE } },
    CONTEXT,
  );
  assert.deepEqual(
    fromGilfoyle.rows.map((row) => row.share.id),
    ["s1", "s2", "s5"],
  );
  assert.equal(fromGilfoyle.counts.all, 5);
  const mine = filterShares(
    SHARES,
    { ...DEFAULT_SHELF_FILTERS, sender: "me" },
    CONTEXT,
  );
  assert.deepEqual(
    mine.rows.map((row) => row.share.id),
    ["s4"],
  );
  const inFlight = filterShares(
    SHARES,
    { ...DEFAULT_SHELF_FILTERS, channel: { id: FLIGHT } },
    CONTEXT,
  );
  assert.deepEqual(
    inFlight.rows.map((row) => row.share.id),
    ["s3", "s4", "s5"],
  );
  const text = filterShares(
    SHARES,
    { ...DEFAULT_SHELF_FILTERS, text: "gilfoyle takeaways" },
    CONTEXT,
  );
  assert.deepEqual(
    text.rows.map((row) => row.share.id),
    ["s1"],
  );
});

test("rows group by local day: Today, Yesterday, then the weekday", () => {
  const { rows } = filterShares(SHARES, DEFAULT_SHELF_FILTERS, CONTEXT);
  const groups = groupByDay(rows, NOW);
  assert.deepEqual(
    groups.map((group) => [group.label, group.rows.length]),
    [
      ["Today", 3],
      ["Yesterday", 1],
      [
        new Date(at(3, 12) * 1000).toLocaleDateString("en-US", {
          weekday: "long",
        }),
        1,
      ],
    ],
  );
  assert.equal(dayLabel(at(10, 9), NOW).includes("September"), true);
});

test("the When column: a clock today, a weekday this week, a date after", () => {
  assert.equal(whenLabel(at(0, 21, 4), NOW), "9:04 PM");
  assert.equal(
    whenLabel(at(3, 12), NOW),
    new Date(at(3, 12) * 1000).toLocaleDateString("en-US", {
      weekday: "short",
    }),
  );
  assert.equal(whenLabel(at(10, 9), NOW), "Sep 20");
});

test("new = shared by someone else since the last visit (today before any)", () => {
  assert.equal(newShareCount(SHARES, at(0, 21, 0), ME, NOW), 1);
  assert.equal(newShareCount(SHARES, at(0, 20, 0), ME, NOW), 2);
  assert.equal(newShareCount(SHARES, at(0, 15, 0), ME, NOW), 3);
  // Never visited: today's, not mine.
  assert.equal(newShareCount(SHARES, null, ME, NOW), 3);
  assert.equal(newShareCount(SHARES, NOW, ME, NOW), 0);
});

test("senders by share count; sorting is total", () => {
  // Gilfoyle 3; Sam and Nikon 1 each, tied, so by key.
  assert.deepEqual(senderOptions(SHARES), [GILFOYLE, ME, NIKON]);
  const tie = [share("b", ME, DM, 10, []), share("a", ME, DM, 10, [])];
  assert.deepEqual(
    sortShares(tie).map((s) => s.id),
    ["a", "b"],
  );
});

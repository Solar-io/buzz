import assert from "node:assert/strict";
import { test } from "node:test";

import {
  reduceStageSession,
  stageHistoryFilter,
  STAGE_WINDOW_SECONDS,
} from "./stageSession.ts";
import { buildStageTag } from "./stageTag.ts";

const AGENT = "a".repeat(64);
const INTRUDER = "b".repeat(64);
const CHANNEL = "chan-1";
const OPEN_ID = `${"0".repeat(63)}1`;
const T0 = 1_800_000_000;

const hex = (n) => n.toString(16).padStart(64, "0");
const imgUrl = (n) => `https://relay.test/media/${hex(n)}.png`;

function openEvent({ parts = 3, pubkey = AGENT, voice = true } = {}) {
  return {
    id: OPEN_ID,
    pubkey,
    created_at: T0,
    kind: 9,
    content: "🎬 Stage",
    tags: [
      ["h", CHANNEL],
      buildStageTag({
        v: 1,
        op: "open",
        title: "Trip",
        voice,
        parts: Array.from({ length: parts }, (_, n) => ({
          x: hex(n),
          url: imgUrl(n),
          m: "image/png",
        })),
      }),
    ],
  };
}

let seq = 100;
function part(i, overrides = {}) {
  seq += 1;
  const {
    id = hex(seq),
    pubkey = AGENT,
    created_at = T0 + seq,
    h = CHANNEL,
    s = OPEN_ID,
    hold = true,
    text = `Paragraph for frame ${i}.`,
    image = imgUrl(i),
    rawTag,
  } = overrides;
  return {
    id,
    pubkey,
    created_at,
    kind: 9,
    content: `${text}\n![image](${image})`,
    tags: [
      ["h", h],
      ["imeta", `url ${image}`, "m image/png"],
      rawTag ?? buildStageTag({ v: 1, op: "part", s, i, hold }),
    ],
  };
}

test("a valid open with three parts yields three ordered showings", () => {
  const events = [part(0), part(1), part(2)];
  const session = reduceStageSession(openEvent(), events);
  assert.ok(session);
  assert.equal(session.showings.length, 3);
  assert.deepEqual(
    session.showings.map((s) => s.i),
    [0, 1, 2],
  );
  assert.equal(session.title, "Trip");
  assert.equal(session.palette.length, 3);
  assert.equal(session.closed, false);
  assert.equal(session.showings[1].text, "Paragraph for frame 1.");
  assert.equal(session.showings[1].imageUrl, imgUrl(1));
});

test("foreign-author part is excluded (anti-injection, U4)", () => {
  const mine = part(0);
  const foreign = part(1, { pubkey: INTRUDER });
  const session = reduceStageSession(openEvent(), [mine, foreign]);
  assert.equal(session.showings.length, 1);
  assert.equal(session.showings[0].eventId, mine.id);
});

test("foreign-author close does not end the session", () => {
  const close = {
    ...part(0),
    pubkey: INTRUDER,
    tags: [["h", CHANNEL], buildStageTag({ v: 1, op: "close", s: OPEN_ID })],
  };
  const session = reduceStageSession(openEvent(), [part(0), close]);
  assert.equal(session.closed, false);
  assert.equal(session.showings.length, 1);
});

test("wrong session id or wrong channel is excluded", () => {
  const wrongS = part(0, { s: "f".repeat(64) });
  const wrongH = part(1, { h: "other-channel" });
  const ok = part(2);
  const session = reduceStageSession(openEvent(), [wrongS, wrongH, ok]);
  assert.equal(session.showings.length, 1);
  assert.equal(session.showings[0].eventId, ok.id);
});

test("i >= palette length is rejected; 1.0 never parses", () => {
  const outOfRange = part(3);
  const floaty = part(1, {
    rawTag: ["stage", `{"v":1,"op":"part","s":"${OPEN_ID}","i":1.0}`],
  });
  const ok = part(2);
  const session = reduceStageSession(openEvent({ parts: 3 }), [
    outOfRange,
    floaty,
    ok,
  ]);
  assert.equal(session.showings.length, 1);
  assert.equal(session.showings[0].i, 2);
});

test("created_at outside [open, open + 24 h] is excluded", () => {
  const before = part(0, { created_at: T0 - 1 });
  const after = part(1, { created_at: T0 + STAGE_WINDOW_SECONDS + 1 });
  const edge = part(2, { created_at: T0 + STAGE_WINDOW_SECONDS });
  const session = reduceStageSession(openEvent(), [before, after, edge]);
  assert.equal(session.showings.length, 1);
  assert.equal(session.showings[0].eventId, edge.id);
});

test("same i twice = two showings in post order (palette, not dedupe)", () => {
  const first = part(1, { created_at: T0 + 10, text: "First look." });
  const again = part(1, { created_at: T0 + 20, text: "Back to this one." });
  const session = reduceStageSession(openEvent(), [again, first]);
  assert.equal(session.showings.length, 2);
  assert.deepEqual(
    session.showings.map((s) => s.text),
    ["First look.", "Back to this one."],
  );
});

test("out-of-order arrival is sorted by created_at, then event id", () => {
  const a = part(0, { id: hex(900), created_at: T0 + 5 });
  const b = part(1, { id: hex(901), created_at: T0 + 5 });
  const c = part(2, { id: hex(800), created_at: T0 + 3 });
  const session = reduceStageSession(openEvent(), [b, a, c]);
  assert.equal(session.showings.length, 3);
  assert.deepEqual(
    session.showings.map((s) => s.eventId),
    [c.id, a.id, b.id],
  );
});

test("duplicate event ids count once; hold is carried through", () => {
  const p = part(0, { hold: false });
  const session = reduceStageSession(openEvent(), [p, p]);
  assert.equal(session.showings.length, 1);
  assert.equal(session.showings[0].hold, false);
});

test("the part's own image wins over the palette", () => {
  const other = `https://relay.test/media/${"e".repeat(64)}.png`;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const session = reduceStageSession(openEvent(), [
      part(0, { image: other }),
    ]);
    assert.equal(session.showings.length, 1);
    assert.equal(session.showings[0].imageUrl, other);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("a valid close marks the session closed", () => {
  const close = {
    ...part(0),
    tags: [["h", CHANNEL], buildStageTag({ v: 1, op: "close", s: OPEN_ID })],
  };
  const session = reduceStageSession(openEvent(), [part(0), close]);
  assert.equal(session.closed, true);
  assert.equal(session.showings.length, 1);
});

test("a non-open event yields null; speakText strips markdown", () => {
  assert.equal(reduceStageSession(part(0), []), null);
  const session = reduceStageSession(openEvent(), [
    part(0, { text: "**Bold** and [a link](https://x.test) `code`" }),
  ]);
  assert.equal(session.showings.length, 1);
  assert.equal(session.showings[0].speakText, "Bold and a link code");
});

test("history filter is the §4.4 h + authors window query", () => {
  assert.deepEqual(
    stageHistoryFilter({ pubkey: AGENT, created_at: T0, channelId: CHANNEL }),
    {
      kinds: [9],
      "#h": [CHANNEL],
      authors: [AGENT],
      since: T0,
      until: T0 + 86_400,
      limit: 500,
    },
  );
});

test("bug1: same-second showings order by seq when both carry one, else id", () => {
  const tagged = (i, id, seqValue) =>
    part(i, {
      id,
      created_at: T0 + 7,
      rawTag: buildStageTag({
        v: 1,
        op: "part",
        s: OPEN_ID,
        i,
        hold: true,
        ...(seqValue === undefined ? {} : { seq: seqValue }),
      }),
    });
  const first = tagged(0, hex(0xff), 0); // posted first, larger id
  const second = tagged(1, hex(0x03), 1); // posted second, smaller id
  const session = reduceStageSession(openEvent(), [second, first]);
  assert.deepEqual(
    session.showings.map((s) => s.eventId),
    [first.id, second.id],
  );
  assert.equal(session.showings[0].seq, 0);
  // Without seq on one side, the id tiebreak still applies.
  const legacy = tagged(1, hex(0x02));
  const mixed = reduceStageSession(openEvent(), [first, legacy]);
  assert.deepEqual(
    mixed.showings.map((s) => s.eventId),
    [legacy.id, first.id],
  );
});

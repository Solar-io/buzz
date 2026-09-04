import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchContactPubkeys,
  fetchGlobalNotes,
  fetchLikedNotes,
  fetchNotesByAuthors,
  fetchReactionState,
  MAX_TIMELINE_AUTHORS,
  publishNote,
  upvoteNote,
} from "./noteService.ts";

const ME = "aa".repeat(32);
const ALICE = "bb".repeat(32);
const T = 1_800_000_000;

function event(overrides) {
  return {
    id: "e1",
    pubkey: ME,
    kind: 1,
    created_at: T,
    content: "",
    tags: [],
    sig: "f".repeat(128),
    ...overrides,
  };
}

/**
 * A relay that answers each REQ from a queue of responses, in order, and
 * records the filter it was asked. Chained reads (Liked is three) are
 * therefore checkable step by step rather than only by their end result.
 */
function fakeSession(responses = []) {
  const queue = [...responses];
  const filters = [];
  const published = [];
  return {
    filters,
    published,
    subscribe(filter, options) {
      filters.push(filter);
      for (const item of queue.shift() ?? []) {
        options.onEvent(item);
      }
      options.onEose?.();
      return () => {};
    },
    async publish(item) {
      published.push(item);
      return { ok: true, message: "" };
    },
  };
}

const signer = async (template) =>
  event({ ...template, id: "signed", created_at: T });

test("fetchGlobalNotes asks for kind:1 with no author constraint", async () => {
  const session = fakeSession([[event({ id: "n1", content: "hi" })]]);
  const notes = await fetchGlobalNotes(session);
  assert.deepEqual(session.filters[0].kinds, [1]);
  assert.equal(session.filters[0].authors, undefined);
  assert.deepEqual(
    notes.map((n) => n.id),
    ["n1"],
  );
});

test("fetchGlobalNotes strips project comments and orders newest first", async () => {
  const session = fakeSession([
    [
      event({ id: "old", created_at: T - 100 }),
      event({ id: "new", created_at: T }),
      event({
        id: "project",
        created_at: T - 1,
        tags: [["a", `30617:${ME}:repo`]],
      }),
    ],
  ]);
  const notes = await fetchGlobalNotes(session);
  assert.deepEqual(
    notes.map((n) => n.id),
    ["new", "old"],
  );
});

test("fetchNotesByAuthors sends ONE multi-author filter", async () => {
  const session = fakeSession([[]]);
  await fetchNotesByAuthors(session, [ME, ALICE], 10);
  assert.equal(session.filters.length, 1);
  assert.deepEqual(session.filters[0].authors, [ME, ALICE]);
  assert.equal(session.filters[0].limit, 20);
});

test("fetchNotesByAuthors makes no request at all for an empty author set", async () => {
  // `authors: []` is not "everyone" to a relay, but sending one is a wasted
  // round trip and a Following tab that could turn into a second global feed.
  const session = fakeSession([[event({ id: "should-not-appear" })]]);
  assert.deepEqual(await fetchNotesByAuthors(session, []), []);
  assert.equal(session.filters.length, 0);
});

test("fetchNotesByAuthors caps the author list and the page size", async () => {
  const many = Array.from({ length: 150 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  const session = fakeSession([[]]);
  await fetchNotesByAuthors(session, many, 10);
  assert.equal(session.filters[0].authors.length, MAX_TIMELINE_AUTHORS);
  assert.equal(session.filters[0].limit, 200);
});

test("fetchLikedNotes chains reactions, deletions, then the notes", async () => {
  const reaction = event({
    id: "r1",
    kind: 7,
    content: "+",
    tags: [["e", "n1"]],
  });
  const session = fakeSession([
    [reaction],
    [],
    [event({ id: "n1", content: "liked note" })],
  ]);
  const notes = await fetchLikedNotes(session, ME, 50);

  assert.equal(session.filters.length, 3);
  assert.deepEqual(session.filters[0].kinds, [7]);
  assert.deepEqual(session.filters[0].authors, [ME]);
  assert.deepEqual(session.filters[1].kinds, [5]);
  assert.deepEqual(session.filters[1]["#e"], ["r1"]);
  assert.deepEqual(session.filters[2].ids, ["n1"]);
  assert.deepEqual(
    notes.map((n) => n.id),
    ["n1"],
  );
});

test("fetchLikedNotes stops after the first read when nothing is liked", async () => {
  const session = fakeSession([[]]);
  assert.deepEqual(await fetchLikedNotes(session, ME, 50), []);
  assert.equal(session.filters.length, 1);
});

test("fetchLikedNotes stops when every reaction was retracted", async () => {
  const reaction = event({
    id: "r1",
    kind: 7,
    content: "+",
    tags: [["e", "n1"]],
  });
  const deletion = event({ id: "d1", kind: 5, tags: [["e", "r1"]] });
  const session = fakeSession([[reaction], [deletion]]);
  assert.deepEqual(await fetchLikedNotes(session, ME, 50), []);
  assert.equal(session.filters.length, 2, "no pointless third read");
});

test("fetchReactionState folds reactions minus their deletions", async () => {
  const reactions = [
    event({ id: "r1", pubkey: ME, kind: 7, content: "+", tags: [["e", "n1"]] }),
    event({
      id: "r2",
      pubkey: ALICE,
      kind: 7,
      content: "+",
      tags: [["e", "n1"]],
    }),
  ];
  const session = fakeSession([
    reactions,
    [event({ id: "d1", kind: 5, tags: [["e", "r2"]] })],
  ]);
  const state = await fetchReactionState(session, ["n1"], ME);
  assert.deepEqual(session.filters[0]["#e"], ["n1"]);
  assert.deepEqual(state.get("n1"), { count: 1, reactedByCurrentUser: true });
});

test("fetchReactionState makes no request for an empty note list", async () => {
  const session = fakeSession();
  assert.equal((await fetchReactionState(session, [], ME)).size, 0);
  assert.equal(session.filters.length, 0);
});

test("fetchContactPubkeys reads p tags from the NEWEST kind:3", async () => {
  // kind:3 is replaceable, but a reconnect replay can deliver an older copy
  // alongside the current one. Taking the wrong one un-follows people.
  const session = fakeSession([
    [
      event({ id: "old", kind: 3, created_at: T - 100, tags: [["p", ALICE]] }),
      event({
        id: "new",
        kind: 3,
        created_at: T,
        tags: [
          ["p", ME],
          ["p", ALICE],
          ["e", "not-a-contact"],
        ],
      }),
    ],
  ]);
  assert.deepEqual(await fetchContactPubkeys(session, ME), [ME, ALICE]);
});

test("fetchContactPubkeys returns nothing when there is no contact list", async () => {
  assert.deepEqual(await fetchContactPubkeys(fakeSession([[]]), ME), []);
});

test("publishNote signs a kind:1 with reply and mention tags", async () => {
  const session = fakeSession();
  await publishNote(
    session,
    { content: "hello", replyTo: "parent", mentionPubkeys: [ALICE] },
    signer,
  );
  const [event_] = session.published;
  assert.equal(event_.kind, 1);
  assert.equal(event_.content, "hello");
  assert.deepEqual(event_.tags, [
    ["e", "parent", "", "reply"],
    ["p", ALICE],
  ]);
});

test("publishNote leaves a top-level note untagged", async () => {
  const session = fakeSession();
  await publishNote(session, { content: "hello" }, signer);
  assert.deepEqual(session.published[0].tags, []);
});

test("upvoteNote publishes a kind:7 whose content is +", async () => {
  const session = fakeSession();
  await upvoteNote(session, "n1", signer);
  const [event_] = session.published;
  assert.equal(event_.kind, 7);
  assert.equal(event_.content, "+");
  assert.deepEqual(event_.tags, [["e", "n1"]]);
});

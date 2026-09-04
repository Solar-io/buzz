import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContactListNotLoadedError,
  KIND_CONTACT_LIST,
  buildContactListEvent,
  followedPubkeys,
  isFollowing,
  pickLatestContactList,
} from "./contactList.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

const PREVIOUS = {
  kind: 3,
  created_at: 100,
  content: '{"wss://relay.example":{"read":true,"write":true}}',
  tags: [
    ["p", ALICE, "wss://relay.example", "alice"],
    ["p", BOB],
    ["t", "unmodelled-tag"],
  ],
};

test("followedPubkeys reads p tags, ignores everything else", () => {
  assert.deepEqual(followedPubkeys(PREVIOUS), [ALICE, BOB]);
  assert.deepEqual(followedPubkeys(null), []);
  assert.deepEqual(
    followedPubkeys({
      ...PREVIOUS,
      tags: [
        ["p", "not-hex"],
        ["p", ALICE],
        ["p", ALICE],
      ],
    }),
    [ALICE],
  );
});

test("isFollowing is case-insensitive", () => {
  assert.equal(isFollowing(PREVIOUS, ALICE.toUpperCase()), true);
  assert.equal(isFollowing(PREVIOUS, CAROL), false);
  assert.equal(isFollowing(null, ALICE), false);
});

test("following APPENDS and preserves every existing tag verbatim", () => {
  // The failure this guards: emitting only the new follow replaces the whole
  // list, silently unfollowing everyone. Relay hints and petnames must
  // survive too — this client does not model them and must not drop them.
  const event = buildContactListEvent({
    previous: PREVIOUS,
    loaded: true,
    pubkey: CAROL,
    follow: true,
  });
  assert.equal(event.kind, KIND_CONTACT_LIST);
  assert.deepEqual(event.tags, [
    ["p", ALICE, "wss://relay.example", "alice"],
    ["p", BOB],
    ["t", "unmodelled-tag"],
    ["p", CAROL],
  ]);
});

test("content is carried across untouched", () => {
  // Some clients keep relay metadata or an encrypted list there. Rewriting it
  // to "" would destroy data this client cannot even read.
  const event = buildContactListEvent({
    previous: PREVIOUS,
    loaded: true,
    pubkey: CAROL,
    follow: true,
  });
  assert.equal(event.content, PREVIOUS.content);
});

test("unfollowing removes only that entry", () => {
  const event = buildContactListEvent({
    previous: PREVIOUS,
    loaded: true,
    pubkey: ALICE,
    follow: false,
  });
  assert.deepEqual(event.tags, [
    ["p", BOB],
    ["t", "unmodelled-tag"],
  ]);
});

test("following someone already followed does not duplicate them", () => {
  const event = buildContactListEvent({
    previous: PREVIOUS,
    loaded: true,
    pubkey: ALICE.toUpperCase(),
    follow: true,
  });
  assert.deepEqual(followedPubkeys(event), [BOB, ALICE]);
  assert.equal(event.tags.filter((tag) => tag[0] === "p").length, 2);
});

test("an edit before the list has loaded is REFUSED", () => {
  // "Not loaded" is indistinguishable from "empty list", and guessing wrong
  // publishes an empty kind:3 over the user's real follows.
  assert.throws(
    () =>
      buildContactListEvent({
        previous: null,
        loaded: false,
        pubkey: CAROL,
        follow: true,
      }),
    ContactListNotLoadedError,
  );
});

test("a first follow with a genuinely absent list is allowed", () => {
  const event = buildContactListEvent({
    previous: null,
    loaded: true,
    pubkey: CAROL,
    follow: true,
  });
  assert.deepEqual(event.tags, [["p", CAROL]]);
  assert.equal(event.content, "");
});

test("a malformed pubkey is refused", () => {
  assert.throws(
    () =>
      buildContactListEvent({
        previous: PREVIOUS,
        loaded: true,
        pubkey: "nope",
        follow: true,
      }),
    /64 hex characters/,
  );
});

test("the newest contact list wins, and a tie keeps the incumbent", () => {
  const older = { ...PREVIOUS, created_at: 50 };
  const newer = { ...PREVIOUS, created_at: 150 };
  assert.equal(pickLatestContactList(null, PREVIOUS), PREVIOUS);
  assert.equal(pickLatestContactList(PREVIOUS, older), PREVIOUS);
  assert.equal(pickLatestContactList(PREVIOUS, newer), newer);
  assert.equal(
    pickLatestContactList(PREVIOUS, { ...PREVIOUS, created_at: 100 }),
    PREVIOUS,
    "a tie must not re-render",
  );
});
